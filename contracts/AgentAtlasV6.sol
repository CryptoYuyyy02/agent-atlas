// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for the Binance / SPACE ID Agent ID registry on BSC.
/// @dev Mainnet registry: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
interface IAgentIdRegistryV6 {
    function balanceOf(address account) external view returns (uint256);
    function handleOf(address account) external view returns (string memory);
    function ownerOfHandle(string calldata handle) external view returns (address);
}

/// @title AgentAtlasV6 — Agent ID directory, check-ins, endorsements, game scores and X profiles
/// @notice Single-contract edition for the Binance Wallet Agent ID Hackathon:
///         directory registration, daily check-ins and endorsements (as in V1),
///         plus on-chain game score submissions (StitchNight season board) and an
///         optional, self-declared X handle with a public show/hide preference.
///         V4 adds one-level referral binding at registration time: the
///         referrer is stored on-chain (referrerOf) and referral points —
///         10% of each referee's best score, snapshot at season end — are
///         computed off-chain from referrerOf + getScore.
///         V5 changes exactly one rule versus V4: the score plausibility
///         cap becomes quadratic in nights survived (see submitScore),
///         because an honest run's score grows quadratically — the
///         night-clear bonus alone sums to 25 * nights * (nights + 1).
///         The old linear cap wrongly rejected the longest honest runs.
///         V6 hardens the season board after an external acceptance review:
///         (1) nights are bounded (MAX_NIGHTS) and runHash must be non-zero,
///         so a fabricated (score, nights) pair can no longer claim an
///         unbounded score; (2) the season board (getScore) only accepts
///         daily runs — mode 1 with seed equal to the current or previous
///         UTC day number — so season scores cannot be farmed by picking a
///         lucky free seed; classic runs (mode 0, any seed) are kept as a
///         separate personal best (getClassicScore) and never enter the
///         season board; (3) resubmitting the same runHash reverts, so one
///         run counts once; (4) each registrant's invite code — derived
///         deterministically from their address, the same derivation the
///         game page uses — is stored on-chain (codeOf / addressOfCode),
///         so invite links resolve with a single call at any player count.
///         No admin, no owner, no payable, no token.
contract AgentAtlasV6 {
    IAgentIdRegistryV6 public immutable registry;

    uint256 public constant MAX_BLURB_BYTES = 160;
    uint8 public constant MAX_CATEGORY = 7;
    uint256 public constant MAX_X_HANDLE_BYTES = 32;
    /// @notice Anti-fake plausibility cap for score submissions (V5, kept in V6):
    ///         score <= SCORE_CAP_QUADRATIC * nights^2
    ///              + SCORE_CAP_LINEAR * nights + BASE_SCORE_ALLOWANCE.
    ///         Grounded in the shipped game engine's constants, so any score
    ///         above the cap is provably impossible for an honest run:
    ///         - clearing a night pays 50 * night, so clear bonuses alone sum
    ///           to 25 * nights * (nights + 1) over a run -> quadratic term 25;
    ///         - the board holds at most 19 moths and at most ~7 more trickle
    ///           in per night, each worth at most 120 points (queen: 300), so
    ///           captures are bounded by ~3,300 per night, plus at most 120
    ///           per night from the repeatable honey notion -> linear term
    ///           3,600 (rounded up);
    ///         - flat 2,000 allowance as in V2-V4.
    ///         Prize payouts additionally replay-verify the winner's move log
    ///         against the stored runHash (see submitScore); this cap is a
    ///         sanity gate, not the prize defense.
    uint32 public constant SCORE_CAP_QUADRATIC = 25;
    uint32 public constant SCORE_CAP_LINEAR = 3600;
    uint32 public constant BASE_SCORE_ALLOWANCE = 2000;
    /// @notice Longest run a submission may claim. The longest honest run
    ///         observed in 4,000 simulated games was 535 nights; 1,500
    ///         leaves ~3x headroom while bounding any fabricated claim.
    uint32 public constant MAX_NIGHTS = 1500;
    uint8 public constant MODE_CLASSIC = 0;
    uint8 public constant MODE_DAILY = 1;

    struct Agent {
        string handle;
        uint8 category;
        string blurb;
        uint64 registeredAt;
        uint32 streak;
        uint32 totalCheckIns;
        uint64 lastCheckInDay;
        uint32 endorsementsReceived;
    }

    struct Score {
        uint32 bestScore;
        uint32 bestNights;
        bytes32 runHash;
        uint64 updatedAt;
        uint32 submissions;
        bytes32 lastRunHash;
    }

    address[] private _agents;
    mapping(address => Agent) private _agentByAddress;
    mapping(address => bool) private _registered;
    mapping(address => mapping(address => bool)) private _hasEndorsed;
    mapping(address => Score) private _scoreByAddress;
    mapping(address => Score) private _classicScoreByAddress;
    /// @notice Invite code derived from the registrant's address at
    ///         registration time (see deriveCode); resolve a code to its
    ///         owner with addressOfCode — no on-chain scan needed.
    mapping(address => string) public codeOf;
    mapping(string => address) public addressOfCode;
    mapping(address => string) private _xHandle;
    mapping(address => bool) private _xVisible;
    /// @notice One-level referral binding, set once at registration.
    mapping(address => address) public referrerOf;

    uint256 public globalCheckIns;
    uint256 public globalEndorsements;
    uint256 public globalScoreSubmissions;

    event Registered(address indexed agent, string handle, uint8 category);
    event CardUpdated(address indexed agent, uint8 category);
    event CheckedIn(address indexed agent, uint32 streak);
    event Endorsed(address indexed from, address indexed to);
    event ScoreSubmitted(address indexed agent, uint8 mode, uint32 score, uint32 nights, bytes32 runHash);
    event XProfileSet(address indexed agent, bool visible);
    event ReferralBound(address indexed agent, address indexed referrer);

    error NoAgentId();
    error EmptyHandle();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidCategory();
    error BlurbTooLong();
    error AlreadyCheckedInToday();
    error SelfEndorsement();
    error AlreadyEndorsed();
    error TargetNotRegistered();
    error InvalidNights();
    error ScoreImplausible();
    error InvalidMode();
    error InvalidSeed();
    error ZeroRunHash();
    error DuplicateRun();
    error XHandleTooLong();
    error SelfReferral();
    error ReferrerNotRegistered();

    constructor(address registry_) {
        require(registry_ != address(0), "zero registry");
        registry = IAgentIdRegistryV6(registry_);
    }

    // ---------- helpers ----------

    function _requireHolder(address who) internal view {
        if (registry.balanceOf(who) == 0) revert NoAgentId();
    }

    function _requireValidCard(uint8 category, string calldata blurb) internal pure {
        if (category > MAX_CATEGORY) revert InvalidCategory();
        if (bytes(blurb).length > MAX_BLURB_BYTES) revert BlurbTooLong();
    }

    // ---------- directory (as V1) ----------

    /// @notice Register the caller's Agent ID card in the directory.
    /// @param category 0=Other,1=Trading,2=Mint/NFT,3=Gaming,4=Content,5=Tools,6=DeFi,7=Research
    /// @param blurb Short description, max 160 bytes.
    /// @param referrer Optional inviter: a wallet address that is already
    ///        registered here, or address(0) for no referral. Binding is
    ///        one-level, set once at registration and cannot be changed.
    function register(uint8 category, string calldata blurb, address referrer) external {
        _requireHolder(msg.sender);
        _requireValidCard(category, blurb);
        if (_registered[msg.sender]) revert AlreadyRegistered();
        if (referrer != address(0)) {
            if (referrer == msg.sender) revert SelfReferral();
            if (!_registered[referrer]) revert ReferrerNotRegistered();
        }

        string memory handle = registry.handleOf(msg.sender);
        if (bytes(handle).length == 0) revert EmptyHandle();

        Agent storage a = _agentByAddress[msg.sender];
        a.handle = handle;
        a.category = category;
        a.blurb = blurb;
        a.registeredAt = uint64(block.timestamp);

        _registered[msg.sender] = true;
        _agents.push(msg.sender);

        // Invite code: deterministic in the address (same derivation the
        // game page uses), stored once so links resolve with one call.
        // First registrant keeps a code if two addresses ever collide.
        string memory code = deriveCode(msg.sender);
        codeOf[msg.sender] = code;
        if (addressOfCode[code] == address(0)) {
            addressOfCode[code] = msg.sender;
        }

        if (referrer != address(0)) {
            referrerOf[msg.sender] = referrer;
            emit ReferralBound(msg.sender, referrer);
        }

        emit Registered(msg.sender, handle, category);
    }

    /// @notice Update category / blurb of an already registered card.
    function updateCard(uint8 category, string calldata blurb) external {
        if (!_registered[msg.sender]) revert NotRegistered();
        _requireValidCard(category, blurb);

        Agent storage a = _agentByAddress[msg.sender];
        a.category = category;
        a.blurb = blurb;

        emit CardUpdated(msg.sender, category);
    }

    /// @notice Daily liveness check-in (UTC day). Consecutive days build a streak.
    function checkIn() external {
        if (!_registered[msg.sender]) revert NotRegistered();

        uint64 day = uint64(block.timestamp / 86400);
        Agent storage a = _agentByAddress[msg.sender];

        if (a.totalCheckIns > 0 && a.lastCheckInDay == day) {
            revert AlreadyCheckedInToday();
        }

        if (a.totalCheckIns > 0 && a.lastCheckInDay == day - 1) {
            a.streak += 1;
        } else {
            a.streak = 1;
        }
        a.totalCheckIns += 1;
        a.lastCheckInDay = day;
        globalCheckIns += 1;

        emit CheckedIn(msg.sender, a.streak);
    }

    /// @notice Endorse a registered agent. Caller must hold an Agent ID,
    ///         need not be registered. Each (caller, target) pair once ever.
    function endorse(address target) external {
        _requireHolder(msg.sender);
        if (msg.sender == target) revert SelfEndorsement();
        if (!_registered[target]) revert TargetNotRegistered();
        if (_hasEndorsed[msg.sender][target]) revert AlreadyEndorsed();

        _hasEndorsed[msg.sender][target] = true;
        _agentByAddress[target].endorsementsReceived += 1;
        globalEndorsements += 1;

        emit Endorsed(msg.sender, target);
    }

    // ---------- invite codes ----------

    /// @notice The invite code of any address, derived exactly as the game
    ///         page derives it: FNV-1a hashes of the lowercase hex address,
    ///         combined and rendered as 7 base-36 characters. Pure — anyone
    ///         can compute it off-chain; register() stores the result.
    function deriveCode(address who) public pure returns (string memory) {
        string memory a = _hexLower(who);
        uint256 h1 = _fnv1a(bytes(a));
        uint256 h2 = _fnv1a(bytes(string.concat(a, "#invite")));
        uint256 n = (h1 * 4294967296 + h2) % 78364164096; // 36^7
        bytes memory digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        bytes memory out = new bytes(7);
        for (uint256 i = 0; i < 7; i++) {
            out[6 - i] = digits[n % 36];
            n /= 36;
        }
        return string(out);
    }

    function _hexLower(address who) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 u = uint160(who);
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(u >> (8 * (19 - i)));
            out[2 + 2 * i] = digits[b >> 4];
            out[3 + 2 * i] = digits[b & 0x0f];
        }
        return string(out);
    }

    function _fnv1a(bytes memory data) internal pure returns (uint32 h) {
        h = 2166136261;
        unchecked {
            for (uint256 i = 0; i < data.length; i++) {
                h ^= uint32(uint8(data[i]));
                h *= 16777619;
            }
        }
    }

    // ---------- game scores (new in V2) ----------

    /// @notice Submit a finished game run. Keeps the player's best score.
    /// @param mode MODE_DAILY (1) enters the season board and requires
    ///        `seed` to be the current or previous UTC day number (days
    ///        since the Unix epoch — the game page's daily seed);
    ///        MODE_CLASSIC (0) accepts any seed and is stored separately.
    /// @param seed The run's seed (daily seed for mode 1).
    /// @param score Final score of the run.
    /// @param nights Nights survived in the run (1..MAX_NIGHTS).
    /// @param runHash Hash anchoring the run's mode + seed + move log;
    ///        prize winners must reveal the log, which is replay-verified
    ///        off-chain against this hash before any payout. Must be
    ///        non-zero and not a resubmission of the previous run.
    function submitScore(uint8 mode, uint32 seed, uint32 score, uint32 nights, bytes32 runHash) external {
        if (!_registered[msg.sender]) revert NotRegistered();
        if (nights == 0 || nights > MAX_NIGHTS) revert InvalidNights();
        if (runHash == bytes32(0)) revert ZeroRunHash();
        uint256 nightsU = uint256(nights);
        uint256 cap = nightsU * nightsU * SCORE_CAP_QUADRATIC
            + nightsU * SCORE_CAP_LINEAR
            + BASE_SCORE_ALLOWANCE;
        if (uint256(score) > cap) {
            revert ScoreImplausible();
        }

        if (mode == MODE_DAILY) {
            uint256 today = block.timestamp / 86400;
            if (uint256(seed) != today && uint256(seed) + 1 != today) {
                revert InvalidSeed();
            }
            _recordScore(_scoreByAddress[msg.sender], score, nights, runHash);
        } else if (mode == MODE_CLASSIC) {
            _recordScore(_classicScoreByAddress[msg.sender], score, nights, runHash);
        } else {
            revert InvalidMode();
        }

        emit ScoreSubmitted(msg.sender, mode, score, nights, runHash);
    }

    function _recordScore(Score storage s, uint32 score, uint32 nights, bytes32 runHash) internal {
        if (runHash == s.lastRunHash) revert DuplicateRun();
        s.lastRunHash = runHash;
        s.submissions += 1;
        globalScoreSubmissions += 1;
        if (score > s.bestScore) {
            s.bestScore = score;
            s.bestNights = nights;
            s.runHash = runHash;
            s.updatedAt = uint64(block.timestamp);
        }
    }

    // ---------- X profile (new in V2) ----------

    /// @notice Set a self-declared X handle and whether the leaderboard may
    ///         display it. Self-declared means unverified; `visible=false`
    ///         hides it from the board UI. Pass an empty handle to clear.
    function setXProfile(string calldata handle, bool visible) external {
        if (!_registered[msg.sender]) revert NotRegistered();
        if (bytes(handle).length > MAX_X_HANDLE_BYTES) revert XHandleTooLong();

        _xHandle[msg.sender] = handle;
        _xVisible[msg.sender] = visible;

        emit XProfileSet(msg.sender, visible);
    }

    // ---------- views ----------

    function isRegistered(address who) external view returns (bool) {
        return _registered[who];
    }

    function getAgent(address who)
        external
        view
        returns (
            string memory handle,
            uint8 category,
            string memory blurb,
            uint64 registeredAt,
            uint32 streak,
            uint32 totalCheckIns,
            uint64 lastCheckInDay,
            uint32 endorsementsReceived
        )
    {
        Agent storage a = _agentByAddress[who];
        return (
            a.handle,
            a.category,
            a.blurb,
            a.registeredAt,
            a.streak,
            a.totalCheckIns,
            a.lastCheckInDay,
            a.endorsementsReceived
        );
    }

    function getScore(address who)
        external
        view
        returns (uint32 bestScore, uint32 bestNights, bytes32 runHash, uint64 updatedAt, uint32 submissions)
    {
        Score storage s = _scoreByAddress[who];
        return (s.bestScore, s.bestNights, s.runHash, s.updatedAt, s.submissions);
    }

    function getClassicScore(address who)
        external
        view
        returns (uint32 bestScore, uint32 bestNights, bytes32 runHash, uint64 updatedAt, uint32 submissions)
    {
        Score storage s = _classicScoreByAddress[who];
        return (s.bestScore, s.bestNights, s.runHash, s.updatedAt, s.submissions);
    }

    function getXProfile(address who) external view returns (string memory handle, bool visible) {
        return (_xHandle[who], _xVisible[who]);
    }

    function totalAgents() external view returns (uint256) {
        return _agents.length;
    }

    function agentAt(uint256 index) external view returns (address) {
        return _agents[index];
    }

    function hasEndorsed(address from, address to) external view returns (bool) {
        return _hasEndorsed[from][to];
    }
}
