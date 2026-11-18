// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 surface used by PrizeVault (BSC USDT in production:
///         0x55d398326f99059fF775485246999027B3197955).
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal AgentAtlas surface used by PrizeVault: the directory
///         registration check (AgentAtlasV6 in production:
///         0x935e72e456cE6b2cc2c7Fa79bbCB843D44C7Eee1).
interface IAtlasRegistry {
    function isRegistered(address account) external view returns (bool);
}

/// @title PrizeVault — StitchNight season prize-pool escrow
/// @notice Holds the season prize pool in a single ERC20. Anyone may fund
///         the vault at any time by transferring tokens to it. Funds can
///         only leave through two disclosed paths:
///         1. distribute(): after the owner submits the final standings and
///            a 72-hour public challenge window has passed, anyone can
///            trigger payouts at the fixed percentages below, computed on
///            the pool balance snapshotted at the first distribute() call.
///         2. reclaim(): the owner's fallback sweep — after distribution is
///            complete, only the part of the balance that is not a locked,
///            undistributed board share (i.e. rounding dust and deposits
///            made after the snapshot); or, once SEASON_END + RECLAIM_DELAY
///            has passed, the entire remaining balance (e.g. if the owner
///            never submits standings).
///         The owner has no other way to move funds, and there is no
///         ownership transfer.
/// @dev Percentages are in hundredths of a percent (10000 = 100% of the
///      pool). Score board: 8000 total — 1st 2000, 2nd 1200, 3rd 800,
///      ranks 4-10 200 each, ranks 11-50 40 each, ranks 51-100 20 each.
///      Referral board: 2000, split pro-rata by points among entries with
///      at least MIN_REF_POINTS points. If no referral entry qualifies, the
///      referral share rolls into the score board (board total 10000). If
///      the score list has fewer than 100 entries, the score board total is
///      scaled pro-rata over the submitted places (divided by the sum of
///      the submitted places' percentages), so the board always pays out
///      its full total. A board with no qualifying entries at all keeps its
///      share locked (see undistributedLocked) until the reclaim fallback
///      delay passes.
contract PrizeVault {
    /// @notice Season end: 2026-12-09 08:00 UTC (16:00 CST).
    uint256 public constant SEASON_END = 1796803200;
    /// @notice Public challenge window between submission and distribution.
    uint256 public constant CHALLENGE_WINDOW = 72 hours;
    /// @notice After SEASON_END + RECLAIM_DELAY the owner may sweep any
    ///         remaining balance (the disclosed fallback).
    uint256 public constant RECLAIM_DELAY = 60 days;
    /// @notice Minimum referral points for a referral-board entry to be
    ///         paid.
    uint256 public constant MIN_REF_POINTS = 100;
    /// @notice Score board total, hundredths of a percent of the pool.
    uint256 public constant SCORE_BOARD_PCT = 8000;
    /// @notice Referral board total, hundredths of a percent of the pool.
    uint256 public constant REFERRAL_BOARD_PCT = 2000;
    uint256 public constant MAX_SCORE_WINNERS = 100;
    uint256 public constant MAX_REF_WINNERS = 200;

    IERC20 public immutable TOKEN;
    IAtlasRegistry public immutable ATLAS;
    /// @notice Deployer; the only account that may submit/cancel standings
    ///         and use the reclaim fallback. Never transferable.
    address public immutable owner;

    // ---- submission state ----
    address[] private _scoreWinners;
    address[] private _refWinners;
    uint256[] private _refPoints;
    /// @notice Submission time of the active standings; 0 = no submission.
    uint256 public submittedAt;

    // ---- distribution state (fixed at the first distribute() call) ----
    bool public snapshotTaken;
    /// @notice Pool balance snapshotted at the first distribute() call;
    ///         all payouts are computed on this amount.
    uint256 public poolSnapshot;
    /// @notice Effective score board total: SCORE_BOARD_PCT, plus
    ///         REFERRAL_BOARD_PCT if no referral entry qualifies.
    uint256 public scoreBoardTotal;
    /// @notice Sum of the place percentages of the submitted score winners.
    uint256 public sumScorePct;
    /// @notice Sum of points over qualifying referral entries only.
    uint256 public totalQualPoints;
    /// @notice Payout cursors: entries already processed.
    uint256 public scoreCursor;
    uint256 public refCursor;
    uint256 public totalPaid;
    /// @notice Part of the snapshot that belongs to a board with no
    ///         qualifying entries; stays locked until the reclaim delay.
    uint256 public undistributedLocked;
    bool public distributed;
    uint256 public distributedAt;
    /// @notice Set when the fallback reclaim is used before distribution
    ///         completed; permanently closes submit/distribute.
    bool public reclaimedEarly;

    event WinnersSubmitted(uint256 scoreCount, uint256 refCount, uint256 submittedAt);
    event SubmissionCancelled();
    event DistributedBatch(uint256 scoreCursor, uint256 refCursor);
    event DistributionComplete(uint256 totalPaid);
    event Reclaimed(uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error SeasonNotOver();
    error AlreadySubmitted();
    error NoActiveSubmission();
    error TooManyScoreWinners();
    error TooManyRefWinners();
    error RefLengthMismatch();
    error DuplicateEntry();
    error NotRegistered(address account);
    error ChallengeWindowOpen();
    error InvalidMaxCount();
    error AlreadyDistributed();
    error DistributionStarted();
    error ReclaimedEarly();
    error ReclaimTooEarly();
    error NothingToReclaim();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_, address atlas_) {
        if (token_ == address(0) || atlas_ == address(0)) revert ZeroAddress();
        TOKEN = IERC20(token_);
        ATLAS = IAtlasRegistry(atlas_);
        owner = msg.sender;
    }

    /// @notice Place percentage (hundredths of a percent) for a 1-based
    ///         score-board rank.
    function scorePct(uint256 rank) public pure returns (uint256) {
        if (rank == 1) return 2000;
        if (rank == 2) return 1200;
        if (rank == 3) return 800;
        if (rank <= 10) return 200;
        if (rank <= 50) return 40;
        return 20; // ranks 51-100
    }

    /// @notice Submit the final standings. Owner only, at or after
    ///         SEASON_END, with no other active submission (cancel first).
    ///         Every listed address must be registered in AgentAtlas.
    ///         The pool snapshot is NOT taken here, only at distribution.
    function submitWinners(
        address[] calldata scoreWinners,
        address[] calldata refWinners,
        uint256[] calldata refPoints
    ) external onlyOwner {
        if (reclaimedEarly) revert ReclaimedEarly();
        if (distributed) revert AlreadyDistributed();
        if (block.timestamp < SEASON_END) revert SeasonNotOver();
        if (submittedAt != 0) revert AlreadySubmitted();
        if (scoreWinners.length > MAX_SCORE_WINNERS) revert TooManyScoreWinners();
        if (refWinners.length != refPoints.length) revert RefLengthMismatch();
        if (refWinners.length > MAX_REF_WINNERS) revert TooManyRefWinners();

        for (uint256 i = 0; i < scoreWinners.length; i++) {
            address a = scoreWinners[i];
            if (a == address(0)) revert ZeroAddress();
            for (uint256 j = 0; j < i; j++) {
                if (scoreWinners[j] == a) revert DuplicateEntry();
            }
            if (!ATLAS.isRegistered(a)) revert NotRegistered(a);
            _scoreWinners.push(a);
        }
        for (uint256 i = 0; i < refWinners.length; i++) {
            address a = refWinners[i];
            if (a == address(0)) revert ZeroAddress();
            for (uint256 j = 0; j < i; j++) {
                if (refWinners[j] == a) revert DuplicateEntry();
            }
            if (!ATLAS.isRegistered(a)) revert NotRegistered(a);
            _refWinners.push(a);
            _refPoints.push(refPoints[i]);
        }

        submittedAt = block.timestamp;
        emit WinnersSubmitted(scoreWinners.length, refWinners.length, block.timestamp);
    }

    /// @notice Cancel the active submission (owner only) as long as
    ///         distribution has not started. A fresh submission restarts
    ///         the challenge window.
    function cancelSubmission() external onlyOwner {
        if (distributed || scoreCursor != 0 || refCursor != 0) {
            revert DistributionStarted();
        }
        if (submittedAt == 0) revert NoActiveSubmission();
        delete _scoreWinners;
        delete _refWinners;
        delete _refPoints;
        submittedAt = 0;
        // Defensive reset: unreachable while the guard above holds (a
        // snapshot implies a cursor moved or distribution completed), but
        // keeps the state machine obviously clean.
        snapshotTaken = false;
        poolSnapshot = 0;
        scoreBoardTotal = 0;
        sumScorePct = 0;
        totalQualPoints = 0;
        totalPaid = 0;
        undistributedLocked = 0;
        emit SubmissionCancelled();
    }

    /// @notice Pay out the standings, at most maxCount entries per call
    ///         (maxCount counts entries processed, including zero-amount
    ///         and sub-threshold skips). Permissionless. Score winners are
    ///         paid first, then referral entries. The first call fixes the
    ///         pool snapshot and the precomputed board totals.
    function distribute(uint256 maxCount) external {
        if (reclaimedEarly) revert ReclaimedEarly();
        if (distributed) revert AlreadyDistributed();
        if (submittedAt == 0) revert NoActiveSubmission();
        if (block.timestamp < submittedAt + CHALLENGE_WINDOW) {
            revert ChallengeWindowOpen();
        }
        if (maxCount == 0) revert InvalidMaxCount();

        if (!snapshotTaken) {
            snapshotTaken = true;
            poolSnapshot = TOKEN.balanceOf(address(this));
            uint256 pctSum = 0;
            for (uint256 i = 0; i < _scoreWinners.length; i++) {
                pctSum += scorePct(i + 1);
            }
            sumScorePct = pctSum;
            uint256 qual = 0;
            for (uint256 i = 0; i < _refPoints.length; i++) {
                if (_refPoints[i] >= MIN_REF_POINTS) qual += _refPoints[i];
            }
            totalQualPoints = qual;
            scoreBoardTotal = SCORE_BOARD_PCT +
                (qual == 0 ? REFERRAL_BOARD_PCT : 0);
        }

        uint256 processed = 0;
        while (scoreCursor < _scoreWinners.length && processed < maxCount) {
            uint256 idx = scoreCursor;
            scoreCursor = idx + 1; // effects before interactions
            processed++;
            // sumScorePct > 0 whenever the score list is non-empty.
            uint256 amount = (poolSnapshot * scoreBoardTotal * scorePct(idx + 1)) /
                (10000 * sumScorePct);
            if (amount > 0) {
                totalPaid += amount;
                if (!TOKEN.transfer(_scoreWinners[idx], amount)) {
                    revert TransferFailed();
                }
            }
        }
        while (refCursor < _refWinners.length && processed < maxCount) {
            uint256 idx = refCursor;
            refCursor = idx + 1; // effects before interactions
            processed++;
            uint256 pts = _refPoints[idx];
            if (pts < MIN_REF_POINTS) continue; // skipped, still processed
            // totalQualPoints > 0 whenever a qualifying entry exists.
            uint256 amount = (poolSnapshot * REFERRAL_BOARD_PCT * pts) /
                (10000 * totalQualPoints);
            if (amount > 0) {
                totalPaid += amount;
                if (!TOKEN.transfer(_refWinners[idx], amount)) {
                    revert TransferFailed();
                }
            }
        }
        emit DistributedBatch(scoreCursor, refCursor);

        if (scoreCursor == _scoreWinners.length && refCursor == _refWinners.length) {
            distributed = true;
            distributedAt = block.timestamp;
            // The share of any board with no qualifying entries stays
            // locked until the reclaim delay; everything else the pool
            // still holds after completion is dust or later deposits.
            uint256 expected = 0;
            if (sumScorePct > 0) {
                expected += (poolSnapshot * scoreBoardTotal) / 10000;
            }
            if (totalQualPoints > 0) {
                expected += (poolSnapshot * REFERRAL_BOARD_PCT) / 10000;
            }
            undistributedLocked = poolSnapshot - expected;
            emit DistributionComplete(totalPaid);
        }
    }

    /// @notice The owner's disclosed fallback sweep. Before the delay this
    ///         only releases, after distribution completed, the balance
    ///         above the locked undistributed board share (rounding dust
    ///         and post-snapshot deposits). After SEASON_END +
    ///         RECLAIM_DELAY it sweeps the entire remaining balance; used
    ///         before distribution completed, it permanently closes the
    ///         submission/distribution path.
    function reclaim() external onlyOwner {
        uint256 balance = TOKEN.balanceOf(address(this));
        if (block.timestamp > SEASON_END + RECLAIM_DELAY) {
            if (!distributed) reclaimedEarly = true;
            if (balance > 0 && !TOKEN.transfer(owner, balance)) {
                revert TransferFailed();
            }
            emit Reclaimed(balance);
            return;
        }
        if (!distributed) revert ReclaimTooEarly();
        uint256 freeAmount = balance > undistributedLocked
            ? balance - undistributedLocked
            : 0;
        if (freeAmount == 0) revert NothingToReclaim();
        if (!TOKEN.transfer(owner, freeAmount)) revert TransferFailed();
        emit Reclaimed(freeAmount);
    }

    /// @notice The submitted score-board standings, in rank order.
    function getScoreWinners() external view returns (address[] memory) {
        return _scoreWinners;
    }

    /// @notice The submitted referral-board standings and their points.
    function getRefWinners()
        external
        view
        returns (address[] memory, uint256[] memory)
    {
        return (_refWinners, _refPoints);
    }
}
