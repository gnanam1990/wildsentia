// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Wildsentia Bounties
/// @notice A pool of USDC that pays bounties on wild animals in the Wildsentia Congo forest
/// (docs/2026-10-19-congo-arc-bounties-design.md). The evaluator (the Wildsentia server) reserves a
/// bounty from the pool on a prey animal it keeps secret, committing to it with keccak256(target,
/// salt). It then pays the wallet of the agent whose predator killed the animal, or of the agent
/// that kept it alive to the deadline, revealing the target and storing the hash of the public
/// record; or it voids the bounty back into the pool. An unsettled bounty returns to the pool once
/// it expires, whoever asks. Reserved money can only go to a payee or back to the pool: the owner
/// can withdraw only what is unreserved, and neither the owner nor the evaluator can be paid.
contract WildsentiaBounties is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Voided,
        Expired
    }

    enum Outcome {
        None,
        Predator,
        Survived
    }

    struct Bounty {
        uint96 amount;
        uint64 expiresAt;
        Status status;
        Outcome outcome;
        address evaluator;
        address payee;
        bytes32 rulesHash;
        bytes32 targetCommit;
        bytes32 target;
        bytes32 recordHash;
    }

    /// @notice The longest a bounty may stay open before anyone can return it to the pool.
    uint64 public constant MAX_DURATION = 30 days;

    IERC20 public immutable usdc;
    address public evaluator;
    bool public settlePaused;
    uint96 public minAmount;
    uint96 public maxAmount;
    /// @notice Unreserved USDC: funded, minus what open bounties hold, plus what came back.
    uint256 public pool;
    /// @notice USDC held by open bounties.
    uint256 public reserved;
    mapping(bytes32 id => Bounty) private _bounties;

    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event BountyPublished(bytes32 indexed id, uint96 amount, uint64 expiresAt, bytes32 rulesHash, bytes32 targetCommit);
    event BountyPaid(
        bytes32 indexed id, Outcome outcome, address indexed payee, uint96 amount, bytes32 target, bytes32 recordHash
    );
    event BountyVoided(bytes32 indexed id, uint96 amount, bytes32 target, bytes32 recordHash);
    event BountyExpired(bytes32 indexed id, uint96 amount);
    event EvaluatorChanged(address indexed previous, address indexed next);
    event SettlePausedSet(bool paused);
    event AmountLimitsSet(uint96 minAmount, uint96 maxAmount);

    error ZeroAddress();
    error ZeroAmount();
    error EmptyId();
    error EmptyRules();
    error EmptyCommit();
    error AmountOutOfRange();
    error ExpiryOutOfRange();
    error BadLimits();
    error PoolTooSmall();
    error AlreadyExists();
    error NotEvaluator();
    error SettleIsPaused();
    error NotOpen();
    error Expired();
    error NotExpired();
    error BadOutcome();
    error BadPayee();
    error BadReveal();
    error AmountMismatch();
    error RenounceDisabled();

    constructor(IERC20 usdc_, address owner_, address evaluator_, uint96 minAmount_, uint96 maxAmount_)
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || evaluator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        evaluator = evaluator_;
        _setLimits(minAmount_, maxAmount_);
        emit EvaluatorChanged(address(0), evaluator_);
    }

    // ---------------------------------------------------------------- pool

    /// @notice Adds the caller's approved USDC to the pool.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - before != amount) revert AmountMismatch();
        pool += amount;
        emit Funded(msg.sender, amount);
    }

    /// @notice Takes unreserved USDC out of the pool. Open bounties are never touched.
    function withdraw(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > pool) revert PoolTooSmall();
        pool -= amount;
        emit Withdrawn(to, amount);
        usdc.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- bounties

    /// @notice Reserves `amount` from the pool for a bounty on a target kept secret by
    /// `targetCommit = keccak256(abi.encode(target, salt))`.
    function publish(bytes32 id, uint96 amount, uint64 expiresAt, bytes32 rulesHash, bytes32 targetCommit)
        external
        nonReentrant
    {
        if (msg.sender != evaluator) revert NotEvaluator();
        if (id == bytes32(0)) revert EmptyId();
        if (rulesHash == bytes32(0)) revert EmptyRules();
        if (targetCommit == bytes32(0)) revert EmptyCommit();
        if (_bounties[id].status != Status.None) revert AlreadyExists();
        if (amount < minAmount || amount > maxAmount) revert AmountOutOfRange();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DURATION) revert ExpiryOutOfRange();
        if (amount > pool) revert PoolTooSmall();
        pool -= amount;
        reserved += amount;
        _bounties[id] = Bounty({
            amount: amount,
            expiresAt: expiresAt,
            status: Status.Open,
            outcome: Outcome.None,
            evaluator: msg.sender,
            payee: address(0),
            rulesHash: rulesHash,
            targetCommit: targetCommit,
            target: bytes32(0),
            recordHash: bytes32(0)
        });
        emit BountyPublished(id, amount, expiresAt, rulesHash, targetCommit);
    }

    /// @notice Pays the bounty to the hunter's agent (`Predator`) or the prey's agent (`Survived`),
    /// revealing the target. Only the evaluator it was published under, before it expires.
    function settle(bytes32 id, Outcome outcome, address payee, bytes32 recordHash, bytes32 target, bytes32 salt)
        external
        nonReentrant
    {
        Bounty storage b = _decidable(id, target, salt);
        if (settlePaused) revert SettleIsPaused();
        if (outcome != Outcome.Predator && outcome != Outcome.Survived) revert BadOutcome();
        if (
            payee == address(0) || payee == address(this) || payee == b.evaluator || payee == evaluator
                || payee == owner()
        ) revert BadPayee();
        uint96 amount = b.amount;
        b.status = Status.Paid;
        b.outcome = outcome;
        b.payee = payee;
        b.target = target;
        b.recordHash = recordHash;
        reserved -= amount;
        emit BountyPaid(id, outcome, payee, amount, target, recordHash);
        usdc.safeTransfer(payee, amount);
    }

    /// @notice Returns a bounty nobody won (the target died another way, no agent steered it...)
    /// to the pool, revealing the target. Only the evaluator it was published under.
    function voidBounty(bytes32 id, bytes32 recordHash, bytes32 target, bytes32 salt) external nonReentrant {
        Bounty storage b = _decidable(id, target, salt);
        uint96 amount = b.amount;
        b.status = Status.Voided;
        b.target = target;
        b.recordHash = recordHash;
        reserved -= amount;
        pool += amount;
        emit BountyVoided(id, amount, target, recordHash);
    }

    /// @notice Returns an unsettled bounty to the pool once it has expired. Anyone may call it, and
    /// pausing never blocks it.
    function expire(bytes32 id) external nonReentrant {
        Bounty storage b = _bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp <= b.expiresAt) revert NotExpired();
        uint96 amount = b.amount;
        b.status = Status.Expired;
        reserved -= amount;
        pool += amount;
        emit BountyExpired(id, amount);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Appoints the evaluator for bounties published from now on. Open bounties keep theirs;
    /// if that key is compromised, pause settlement and let them expire back into the pool.
    function setEvaluator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit EvaluatorChanged(evaluator, next);
        evaluator = next;
    }

    function setSettlePaused(bool paused) external onlyOwner {
        settlePaused = paused;
        emit SettlePausedSet(paused);
    }

    function setAmountLimits(uint96 minAmount_, uint96 maxAmount_) external onlyOwner {
        _setLimits(minAmount_, maxAmount_);
    }

    /// @notice Disabled: without an owner a compromised evaluator could never be replaced.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------- views

    function bounty(bytes32 id) external view returns (Bounty memory) {
        return _bounties[id];
    }

    /// @notice The commit a target and salt make, as `publish` expects it.
    function commitOf(bytes32 target, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, salt));
    }

    // ---------------------------------------------------------------- internal

    function _decidable(bytes32 id, bytes32 target, bytes32 salt) private view returns (Bounty storage b) {
        b = _bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.evaluator) revert NotEvaluator();
        if (block.timestamp > b.expiresAt) revert Expired();
        if (commitOf(target, salt) != b.targetCommit) revert BadReveal();
    }

    function _setLimits(uint96 minAmount_, uint96 maxAmount_) private {
        if (minAmount_ == 0 || minAmount_ > maxAmount_) revert BadLimits();
        minAmount = minAmount_;
        maxAmount = maxAmount_;
        emit AmountLimitsSet(minAmount_, maxAmount_);
    }
}
