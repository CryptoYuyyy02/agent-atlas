const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentAtlas", function () {
  let registry, atlas, deployer, alice, bob, carol, dave;
  let deployGasUsed;

  before(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentIdRegistry");
    registry = await Mock.deploy();
    await registry.waitForDeployment();

    const Atlas = await ethers.getContractFactory("AgentAtlas");
    atlas = await Atlas.deploy(await registry.getAddress());
    const receipt = await (await atlas.deploymentTransaction()).wait();
    deployGasUsed = receipt.gasUsed;
    console.log("    AgentAtlas deploy gasUsed:", deployGasUsed.toString());
    // expose for report generation
    process.env.ATLAS_DEPLOY_GAS = deployGasUsed.toString();

    // Enrol holders: alice, bob, carol are Agent ID holders; dave is NOT.
    await registry.enrol(alice.address, "alice");
    await registry.enrol(bob.address, "bob");
    await registry.enrol(carol.address, "carol");
  });

  it("1. Non-holder register reverts", async function () {
    await expect(
      atlas.connect(dave).register(5, "i have no agent id")
    ).to.be.revertedWithCustomError(atlas, "NoAgentId");
  });

  it("2. Holder registers; fields correct; totalAgents=1; double register reverts", async function () {
    await expect(atlas.connect(alice).register(5, "Free-mint safety sentinel"))
      .to.emit(atlas, "Registered")
      .withArgs(alice.address, "alice", 5);

    const a = await atlas.getAgent(alice.address);
    // ethers v6 returns Result; index access is stable across versions
    expect(a[0]).to.equal("alice"); // handle
    expect(Number(a[1])).to.equal(5); // category
    expect(a[2]).to.equal("Free-mint safety sentinel"); // blurb
    expect(Number(a[4])).to.equal(0); // streak
    expect(Number(a[5])).to.equal(0); // totalCheckIns
    expect(Number(a[7])).to.equal(0); // endorsementsReceived

    expect(await atlas.isRegistered(alice.address)).to.equal(true);
    expect(await atlas.isRegistered(bob.address)).to.equal(false);
    expect(Number(await atlas.totalAgents())).to.equal(1);
    expect(await atlas.agentAt(0)).to.equal(alice.address);

    await expect(
      atlas.connect(alice).register(1, "again")
    ).to.be.revertedWithCustomError(atlas, "AlreadyRegistered");
  });

  it("2b. Invalid category and overlong blurb revert", async function () {
    await expect(
      atlas.connect(bob).register(8, "bad cat")
    ).to.be.revertedWithCustomError(atlas, "InvalidCategory");
    const longBlurb = "x".repeat(161);
    await expect(
      atlas.connect(bob).register(1, longBlurb)
    ).to.be.revertedWithCustomError(atlas, "BlurbTooLong");
  });

  it("3. checkIn: works, same-day reverts, +1 day streak=2, skip 2 days streak resets to 1", async function () {
    await expect(atlas.connect(alice).checkIn())
      .to.emit(atlas, "CheckedIn")
      .withArgs(alice.address, 1);
    let a = await atlas.getAgent(alice.address);
    expect(Number(a[4])).to.equal(1);
    expect(Number(a[5])).to.equal(1);
    expect(Number(await atlas.globalCheckIns())).to.equal(1);

    await expect(
      atlas.connect(alice).checkIn()
    ).to.be.revertedWithCustomError(atlas, "AlreadyCheckedInToday");

    // +1 day -> streak 2
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
    await atlas.connect(alice).checkIn();
    a = await atlas.getAgent(alice.address);
    expect(Number(a[4])).to.equal(2);
    expect(Number(a[5])).to.equal(2);

    // skip 2 days (increase 3 days from last check-in day boundary is not
    // guaranteed; increase 2*86400+86400 to be safely >1 day gap in day index)
    await ethers.provider.send("evm_increaseTime", [3 * 86400]);
    await ethers.provider.send("evm_mine", []);
    await atlas.connect(alice).checkIn();
    a = await atlas.getAgent(alice.address);
    expect(Number(a[4])).to.equal(1); // streak reset
    expect(Number(a[5])).to.equal(3);
    expect(Number(await atlas.globalCheckIns())).to.equal(3);
  });

  it("3b. Unregistered checkIn reverts", async function () {
    await expect(
      atlas.connect(bob).checkIn()
    ).to.be.revertedWithCustomError(atlas, "NotRegistered");
  });

  it("4. endorse: counts, repeat/self/unregistered-target/non-holder all revert", async function () {
    // bob (holder, not registered) endorses alice (registered)
    await expect(atlas.connect(bob).endorse(alice.address))
      .to.emit(atlas, "Endorsed")
      .withArgs(bob.address, alice.address);
    let a = await atlas.getAgent(alice.address);
    expect(Number(a[7])).to.equal(1);
    expect(Number(await atlas.globalEndorsements())).to.equal(1);
    expect(await atlas.hasEndorsed(bob.address, alice.address)).to.equal(true);

    // repeat endorse reverts
    await expect(
      atlas.connect(bob).endorse(alice.address)
    ).to.be.revertedWithCustomError(atlas, "AlreadyEndorsed");

    // self-endorse reverts
    await expect(
      atlas.connect(alice).endorse(alice.address)
    ).to.be.revertedWithCustomError(atlas, "SelfEndorsement");

    // unregistered target reverts (carol is a holder but not registered)
    await expect(
      atlas.connect(bob).endorse(carol.address)
    ).to.be.revertedWithCustomError(atlas, "TargetNotRegistered");

    // non-holder endorse reverts
    await expect(
      atlas.connect(dave).endorse(alice.address)
    ).to.be.revertedWithCustomError(atlas, "NoAgentId");

    // a second distinct endorser works
    await atlas.connect(carol).endorse(alice.address);
    a = await atlas.getAgent(alice.address);
    expect(Number(a[7])).to.equal(2);
    expect(Number(await atlas.globalEndorsements())).to.equal(2);
  });

  it("5. updateCard changes category/blurb; unregistered updateCard reverts", async function () {
    await expect(atlas.connect(alice).updateCard(2, "Now minting safely"))
      .to.emit(atlas, "CardUpdated")
      .withArgs(alice.address, 2);
    const a = await atlas.getAgent(alice.address);
    expect(Number(a[1])).to.equal(2);
    expect(a[2]).to.equal("Now minting safely");
    expect(a[0]).to.equal("alice"); // handle unchanged

    await expect(
      atlas.connect(bob).updateCard(1, "not registered")
    ).to.be.revertedWithCustomError(atlas, "NotRegistered");
  });

  it("6. Second holder can register and be endorsed; counters consistent", async function () {
    await atlas.connect(bob).register(1, "Trading agent");
    expect(Number(await atlas.totalAgents())).to.equal(2);
    expect(await atlas.agentAt(1)).to.equal(bob.address);
    const b = await atlas.getAgent(bob.address);
    expect(b[0]).to.equal("bob");
    await atlas.connect(bob).checkIn();
    expect(Number(await atlas.globalCheckIns())).to.equal(4);
  });
});
