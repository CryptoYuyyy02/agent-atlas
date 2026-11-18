const { expect } = require("chai");
const { ethers } = require("hardhat");

// PrizeVault test suite. The chain clock only moves forward across the
// whole file, so describes are ordered along one timeline:
//   natural time (< SEASON_END) -> SEASON_END -> +72h windows -> ... ->
//   SEASON_END + 60 days (only in the last describe).
const SEASON_END = 1796803200; // 2026-12-09 08:00 UTC, per contract
const HOUR = 3600;
const DAY = 24 * HOUR;
const CHALLENGE = 72 * HOUR;

async function latestTime() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function advanceTo(ts) {
  const now = await latestTime();
  if (now < ts) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
    await ethers.provider.send("evm_mine", []);
  }
}

function randomAddrs(n) {
  return Array.from({ length: n }, () => ethers.Wallet.createRandom().address);
}

async function deployMocks() {
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  const MockAtlas = await ethers.getContractFactory("MockAtlasRegistered");
  const atlas = await MockAtlas.deploy();
  await atlas.waitForDeployment();
  return { usdt, atlas };
}

async function deployVault(usdt, atlas) {
  const Vault = await ethers.getContractFactory("PrizeVault");
  const vault = await Vault.deploy(await usdt.getAddress(), await atlas.getAddress());
  await vault.waitForDeployment();
  return vault;
}

async function deployAll() {
  const { usdt, atlas } = await deployMocks();
  const vault = await deployVault(usdt, atlas);
  return { usdt, atlas, vault };
}

async function registerAll(atlas, addrs) {
  for (const a of addrs) await atlas.setRegistered(a, true);
}

describe("PrizeVault", function () {
  this.timeout(300000);

  let owner, alice, bob, carol, dave, stranger;

  before(async function () {
    [owner, alice, bob, carol, dave, stranger] = await ethers.getSigners();
  });

  // ------------------------------------------------------------------
  describe("1-3, 13. submission gating and validation", function () {
    let usdt, atlas, vault;

    before(async function () {
      ({ usdt, atlas, vault } = await deployAll());
      const receipt = await (await vault.deploymentTransaction()).wait();
      console.log("    PrizeVault deploy gasUsed:", receipt.gasUsed.toString());
      expect(Number(await vault.SEASON_END())).to.equal(SEASON_END);
      await registerAll(atlas, [alice.address, bob.address]);
    });

    it("1. submitWinners reverts before SEASON_END", async function () {
      expect(await latestTime()).to.be.lessThan(SEASON_END);
      await expect(
        vault.submitWinners([alice.address], [], [])
      ).to.be.revertedWithCustomError(vault, "SeasonNotOver");
    });

    it("2. submitWinners reverts for non-owner", async function () {
      await expect(
        vault.connect(alice).submitWinners([alice.address], [], [])
      ).to.be.revertedWithCustomError(vault, "NotOwner");
    });

    describe("validation once the season is over", function () {
      before(async function () {
        await advanceTo(SEASON_END);
      });

      it("3a. reverts with more than 100 score winners", async function () {
        await expect(
          vault.submitWinners(randomAddrs(101), [], [])
        ).to.be.revertedWithCustomError(vault, "TooManyScoreWinners");
      });

      it("3b. reverts on mismatched referral array lengths", async function () {
        await expect(
          vault.submitWinners([], [alice.address], [])
        ).to.be.revertedWithCustomError(vault, "RefLengthMismatch");
      });

      it("3c. reverts with more than 200 referral entries", async function () {
        const refs = randomAddrs(201);
        await expect(
          vault.submitWinners([], refs, refs.map(() => 100))
        ).to.be.revertedWithCustomError(vault, "TooManyRefWinners");
      });

      it("3d. reverts on a zero address (score list)", async function () {
        await expect(
          vault.submitWinners([ethers.ZeroAddress], [], [])
        ).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("3e. reverts on a zero address (referral list)", async function () {
        await expect(
          vault.submitWinners([], [ethers.ZeroAddress], [100])
        ).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("3f. reverts on a duplicate score winner", async function () {
        await expect(
          vault.submitWinners([alice.address, alice.address], [], [])
        ).to.be.revertedWithCustomError(vault, "DuplicateEntry");
      });

      it("3g. reverts on a duplicate referral winner", async function () {
        await expect(
          vault.submitWinners([], [alice.address, alice.address], [100, 200])
        ).to.be.revertedWithCustomError(vault, "DuplicateEntry");
      });

      it("3h. reverts on an unregistered address", async function () {
        const ghost = randomAddrs(1)[0];
        await expect(
          vault.submitWinners([ghost], [], [])
        )
          .to.be.revertedWithCustomError(vault, "NotRegistered")
          .withArgs(ghost);
      });

      it("13. a second submission without cancelling reverts", async function () {
        const tx = await vault.submitWinners([bob.address], [], []);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt.blockNumber);
        expect(Number(await vault.submittedAt())).to.equal(block.timestamp);
        await expect(tx).to.emit(vault, "WinnersSubmitted").withArgs(1, 0, block.timestamp);
        await expect(
          vault.submitWinners([bob.address], [], [])
        ).to.be.revertedWithCustomError(vault, "AlreadySubmitted");
      });
    });
  });

  // ------------------------------------------------------------------
  describe("4-5. full field: challenge window and exact payouts", function () {
    let usdt, atlas, vault, scoreWinners, refWinners;
    const POOL = ethers.parseEther("10000");

    before(async function () {
      ({ usdt, atlas, vault } = await deployAll());
      scoreWinners = randomAddrs(100);
      refWinners = randomAddrs(2);
      await registerAll(atlas, [...scoreWinners, ...refWinners]);
      await usdt.mint(await vault.getAddress(), POOL);
      await vault.submitWinners(scoreWinners, refWinners, [100, 300]);
    });

    it("4. distribute reverts before the challenge window ends", async function () {
      await expect(vault.distribute(10)).to.be.revertedWithCustomError(
        vault,
        "ChallengeWindowOpen"
      );
    });

    it("5. exact payouts across all tiers after the window", async function () {
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await expect(vault.distribute(1000))
        .to.emit(vault, "DistributionComplete")
        .withArgs(POOL);

      const bal = async (a) => usdt.balanceOf(a);
      expect(await bal(scoreWinners[0])).to.equal(ethers.parseEther("2000")); // rank 1
      expect(await bal(scoreWinners[1])).to.equal(ethers.parseEther("1200")); // rank 2
      expect(await bal(scoreWinners[2])).to.equal(ethers.parseEther("800")); // rank 3
      expect(await bal(scoreWinners[4])).to.equal(ethers.parseEther("200")); // rank 5
      expect(await bal(scoreWinners[29])).to.equal(ethers.parseEther("40")); // rank 30
      expect(await bal(scoreWinners[76])).to.equal(ethers.parseEther("20")); // rank 77
      expect(await bal(scoreWinners[99])).to.equal(ethers.parseEther("20")); // rank 100
      // referral: 400 qualifying points total -> 100 pts = 500, 300 pts = 1500
      expect(await bal(refWinners[0])).to.equal(ethers.parseEther("500"));
      expect(await bal(refWinners[1])).to.equal(ethers.parseEther("1500"));

      expect(await vault.totalPaid()).to.equal(POOL);
      expect(await bal(await vault.getAddress())).to.equal(0n);
      expect(await vault.distributed()).to.equal(true);
      expect(await vault.undistributedLocked()).to.equal(0n);
    });

    it("5b. distribute after completion reverts", async function () {
      await expect(vault.distribute(1)).to.be.revertedWithCustomError(
        vault,
        "AlreadyDistributed"
      );
    });
  });

  // ------------------------------------------------------------------
  describe("6. partial field: score board scales to the full pool", function () {
    let usdt, atlas, vault;
    const POOL = ethers.parseEther("10000");

    before(async function () {
      ({ usdt, atlas, vault } = await deployAll());
      await registerAll(atlas, [alice.address, bob.address, carol.address]);
      await usdt.mint(await vault.getAddress(), POOL);
      await vault.submitWinners(
        [alice.address, bob.address, carol.address],
        [],
        []
      );
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
    });

    it("6. three winners split the whole pool 50/30/20", async function () {
      // No referral entries -> referral share rolls in (board total 10000);
      // sumPct = 2000+1200+800 = 4000 -> rank 1 gets pool * 2000/4000 = 1/2.
      await vault.distribute(10);
      expect(await usdt.balanceOf(alice.address)).to.equal(ethers.parseEther("5000"));
      expect(await usdt.balanceOf(bob.address)).to.equal(ethers.parseEther("3000"));
      expect(await usdt.balanceOf(carol.address)).to.equal(ethers.parseEther("2000"));
      expect(await vault.scoreBoardTotal()).to.equal(10000n);
      expect(await vault.totalPaid()).to.equal(POOL);
      expect(await usdt.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    it("6b. an empty submission completes and pays nothing", async function () {
      const v2 = await deployVault(usdt, atlas);
      await usdt.mint(await v2.getAddress(), ethers.parseEther("1000"));
      await v2.submitWinners([], [], []);
      const sub = Number(await v2.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await v2.distribute(1);
      expect(await v2.distributed()).to.equal(true);
      expect(await v2.totalPaid()).to.equal(0n);
      expect(await usdt.balanceOf(await v2.getAddress())).to.equal(
        ethers.parseEther("1000")
      );
    });
  });

  // ------------------------------------------------------------------
  describe("7. sub-threshold referral points roll into the score board", function () {
    let usdt, atlas, vault;
    const POOL = ethers.parseEther("5000");

    before(async function () {
      ({ usdt, atlas, vault } = await deployAll());
      await registerAll(atlas, [alice.address, bob.address, carol.address]);
      await usdt.mint(await vault.getAddress(), POOL);
      await vault.submitWinners(
        [alice.address],
        [bob.address, carol.address],
        [50, 99] // both below MIN_REF_POINTS = 100
      );
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
    });

    it("7. no qualifying referral entries: sole score winner takes all", async function () {
      await vault.distribute(10);
      expect(await vault.totalQualPoints()).to.equal(0n);
      expect(await vault.scoreBoardTotal()).to.equal(10000n);
      expect(await usdt.balanceOf(alice.address)).to.equal(POOL);
      expect(await usdt.balanceOf(bob.address)).to.equal(0n);
      expect(await usdt.balanceOf(carol.address)).to.equal(0n);
      expect(await vault.totalPaid()).to.equal(POOL);
    });
  });

  // ------------------------------------------------------------------
  describe("9. batched distribution matches single-shot", function () {
    let usdt, atlas, vaultSingle, vaultBatch, scoreWinners, refWinners;
    const POOL = ethers.parseEther("7777");
    const REF_POINTS = [150, 90, 250]; // middle entry below threshold

    before(async function () {
      ({ usdt, atlas } = await deployMocks());
      vaultSingle = await deployVault(usdt, atlas);
      vaultBatch = await deployVault(usdt, atlas);
      scoreWinners = randomAddrs(10);
      refWinners = randomAddrs(3);
      await registerAll(atlas, [...scoreWinners, ...refWinners]);
      await usdt.mint(await vaultSingle.getAddress(), POOL);
      await usdt.mint(await vaultBatch.getAddress(), POOL);
    });

    it("9. distribute(2) repeatedly pays exactly the single-shot amounts", async function () {
      const everyone = [...scoreWinners, ...refWinners];
      const balances = async () => {
        const m = new Map();
        for (const a of everyone) m.set(a, await usdt.balanceOf(a));
        return m;
      };

      // Phase 1: single-shot on vaultSingle.
      await vaultSingle.submitWinners(scoreWinners, refWinners, REF_POINTS);
      const sub1 = Number(await vaultSingle.submittedAt());
      await advanceTo(sub1 + CHALLENGE);
      const before1 = await balances();
      await vaultSingle.distribute(1000);
      expect(await vaultSingle.distributed()).to.equal(true);
      const after1 = await balances();
      const paidSingle = new Map(
        everyone.map((a) => [a, after1.get(a) - before1.get(a)])
      );

      // Phase 2: batched on vaultBatch.
      await vaultBatch.submitWinners(scoreWinners, refWinners, REF_POINTS);
      const sub2 = Number(await vaultBatch.submittedAt());
      await advanceTo(sub2 + CHALLENGE);
      const before2 = await balances();

      await vaultBatch.distribute(2);
      expect(await vaultBatch.scoreCursor()).to.equal(2n);
      expect(await vaultBatch.distributed()).to.equal(false);
      let guard = 0;
      while (!(await vaultBatch.distributed())) {
        await vaultBatch.distribute(2);
        if (++guard > 20) throw new Error("batched distribution did not finish");
      }
      const after2 = await balances();
      for (const a of everyone) {
        expect(after2.get(a) - before2.get(a)).to.equal(paidSingle.get(a));
      }
      expect(await vaultBatch.totalPaid()).to.equal(await vaultSingle.totalPaid());
      expect(await usdt.balanceOf(await vaultBatch.getAddress())).to.equal(
        await usdt.balanceOf(await vaultSingle.getAddress())
      );

      // A further distribute after completion reverts.
      await expect(vaultBatch.distribute(1)).to.be.revertedWithCustomError(
        vaultBatch,
        "AlreadyDistributed"
      );
    });
  });

  // ------------------------------------------------------------------
  describe("10-11. cancel and resubmit", function () {
    let usdt, atlas;

    before(async function () {
      ({ usdt, atlas } = await deployMocks());
      await registerAll(atlas, [alice.address, bob.address]);
    });

    it("10. cancel + resubmit restarts the challenge window", async function () {
      const vault = await deployVault(usdt, atlas);
      await usdt.mint(await vault.getAddress(), ethers.parseEther("1000"));

      await vault.submitWinners([alice.address], [], []);
      const sub1 = Number(await vault.submittedAt());
      await expect(vault.cancelSubmission()).to.emit(
        vault,
        "SubmissionCancelled"
      );
      expect(await vault.submittedAt()).to.equal(0n);
      expect(await vault.getScoreWinners()).to.deep.equal([]);

      await vault.submitWinners([bob.address], [], []);
      const sub2 = Number(await vault.submittedAt());
      expect(sub2).to.be.greaterThan(sub1);

      // The OLD deadline passes, but the new window is still running.
      await advanceTo(sub1 + CHALLENGE);
      await expect(vault.distribute(1)).to.be.revertedWithCustomError(
        vault,
        "ChallengeWindowOpen"
      );

      await advanceTo(sub2 + CHALLENGE);
      await vault.distribute(1);
      // Sole score winner, no referrals -> whole pool.
      expect(await usdt.balanceOf(bob.address)).to.equal(ethers.parseEther("1000"));
      expect(await usdt.balanceOf(alice.address)).to.equal(0n);
    });

    it("10b. cancel with no active submission reverts", async function () {
      const vault = await deployVault(usdt, atlas);
      await expect(vault.cancelSubmission()).to.be.revertedWithCustomError(
        vault,
        "NoActiveSubmission"
      );
    });

    it("11. cancel reverts once distribution has started", async function () {
      const vault = await deployVault(usdt, atlas);
      await usdt.mint(await vault.getAddress(), ethers.parseEther("1000"));
      await vault.submitWinners([alice.address, bob.address], [], []);
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await vault.distribute(1); // pays rank 1 only; distribution started
      expect(await vault.scoreCursor()).to.equal(1n);
      await expect(vault.cancelSubmission()).to.be.revertedWithCustomError(
        vault,
        "DistributionStarted"
      );
    });
  });

  // ------------------------------------------------------------------
  describe("12. reclaim after distribution sweeps only dust", function () {
    let usdt, atlas, vault, vaultAddr;
    // Odd wei amount chosen so every tier's payout floors and leaves dust:
    // payouts 400000002 + 240000001 + 160000001 + 200000001 = 1000000005,
    // expected board total 1000000006 -> locked 1 wei, free dust 1 wei.
    const POOL = 1000000007n;

    before(async function () {
      ({ usdt, atlas, vault } = await deployAll());
      vaultAddr = await vault.getAddress();
      await registerAll(atlas, [
        alice.address,
        bob.address,
        carol.address,
        dave.address,
      ]);
      await usdt.mint(vaultAddr, POOL);
      await vault.submitWinners(
        [alice.address, bob.address, carol.address],
        [dave.address],
        [100]
      );
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await vault.distribute(10);
      expect(await vault.distributed()).to.equal(true);
    });

    it("12a. payouts are the exact floored amounts", async function () {
      expect(await usdt.balanceOf(alice.address)).to.equal(400000002n);
      expect(await usdt.balanceOf(bob.address)).to.equal(240000001n);
      expect(await usdt.balanceOf(carol.address)).to.equal(160000001n);
      expect(await usdt.balanceOf(dave.address)).to.equal(200000001n);
      expect(await vault.totalPaid()).to.equal(1000000005n);
      expect(await usdt.balanceOf(vaultAddr)).to.equal(2n); // dust
      expect(await vault.undistributedLocked()).to.equal(1n);
    });

    it("12b. reclaim reverts for non-owner", async function () {
      await expect(
        vault.connect(stranger).reclaim()
      ).to.be.revertedWithCustomError(vault, "NotOwner");
    });

    it("12c. owner sweeps the free dust; the locked wei stays", async function () {
      const ownerBefore = await usdt.balanceOf(owner.address);
      await expect(vault.reclaim()).to.emit(vault, "Reclaimed").withArgs(1n);
      expect(await usdt.balanceOf(owner.address)).to.equal(ownerBefore + 1n);
      expect(await usdt.balanceOf(vaultAddr)).to.equal(1n);
    });

    it("12d. reclaim before distribution (and before the delay) reverts", async function () {
      const v2 = await deployVault(usdt, atlas);
      await usdt.mint(await v2.getAddress(), ethers.parseEther("10"));
      await expect(v2.reclaim()).to.be.revertedWithCustomError(
        v2,
        "ReclaimTooEarly"
      );
    });
  });

  // ------------------------------------------------------------------
  describe("14. zero-amount edge: tiny pool, full field", function () {
    it("14. distribute completes with a 100-wei pool and 100 winners", async function () {
      const { usdt, atlas, vault } = await deployAll();
      const winners = randomAddrs(100);
      await registerAll(atlas, winners);
      await usdt.mint(await vault.getAddress(), 100n);
      await vault.submitWinners(winners, [], []);
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await vault.distribute(1000);
      expect(await vault.distributed()).to.equal(true);
      // rank 1: 100 * 10000 * 2000 / (10000 * 8000) = 25 wei; tail ranks 0.
      expect(await usdt.balanceOf(winners[0])).to.equal(25n);
      expect(await usdt.balanceOf(winners[99])).to.equal(0n);
      expect(await vault.totalPaid()).to.be.lessThanOrEqual(100n);
    });
  });

  // ------------------------------------------------------------------
  describe("8. referral-only field and the reclaim fallback", function () {
    let usdt, atlas;

    before(async function () {
      ({ usdt, atlas } = await deployMocks());
      await registerAll(atlas, [alice.address]);
    });

    it("8. referral board pays its 20%; the rest unlocks after 60 days", async function () {
      const vault = await deployVault(usdt, atlas);
      const vaultAddr = await vault.getAddress();
      await usdt.mint(vaultAddr, ethers.parseEther("10000"));
      await vault.submitWinners([], [alice.address], [200]);
      const sub = Number(await vault.submittedAt());
      await advanceTo(sub + CHALLENGE);
      await vault.distribute(5);

      expect(await vault.distributed()).to.equal(true);
      expect(await usdt.balanceOf(alice.address)).to.equal(
        ethers.parseEther("2000")
      );
      expect(await usdt.balanceOf(vaultAddr)).to.equal(ethers.parseEther("8000"));
      expect(await vault.undistributedLocked()).to.equal(
        ethers.parseEther("8000")
      );

      // The undistributed score-board share is NOT dust: reclaim must wait.
      await expect(vault.reclaim()).to.be.revertedWithCustomError(
        vault,
        "NothingToReclaim"
      );

      await advanceTo(SEASON_END + 60 * DAY + 1);
      const ownerBefore = await usdt.balanceOf(owner.address);
      await expect(vault.reclaim())
        .to.emit(vault, "Reclaimed")
        .withArgs(ethers.parseEther("8000"));
      expect(await usdt.balanceOf(owner.address)).to.equal(
        ownerBefore + ethers.parseEther("8000")
      );
      expect(await usdt.balanceOf(vaultAddr)).to.equal(0n);
    });

    it("8b. fallback reclaim before any submission closes the vault", async function () {
      const vault = await deployVault(usdt, atlas);
      const vaultAddr = await vault.getAddress();
      await usdt.mint(vaultAddr, ethers.parseEther("1234"));
      // Clock is already past SEASON_END + RECLAIM_DELAY here.
      await vault.reclaim();
      expect(await usdt.balanceOf(vaultAddr)).to.equal(0n);
      expect(await vault.reclaimedEarly()).to.equal(true);
      await expect(
        vault.submitWinners([alice.address], [], [])
      ).to.be.revertedWithCustomError(vault, "ReclaimedEarly");
      await expect(vault.distribute(1)).to.be.revertedWithCustomError(
        vault,
        "ReclaimedEarly"
      );
    });
  });
});
