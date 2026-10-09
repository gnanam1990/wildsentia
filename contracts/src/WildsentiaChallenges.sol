// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Wildsentia Challenges
/// @notice A creator locks a USDC prize behind a goal. The evaluator pays it to the first player
/// to meet the goal; if nobody does by the deadline, anyone can return it to the creator.
/// A locked prize can only ever go to a winner who is not the creator, or back to the creator.
/// The owner can change the evaluator, pause payouts and set prize limits, never move funds.
contract WildsentiaChallenges is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Resolved,
        Refunded
    }

    struct Challenge {
        address creator;
        uint96 prize;
        address winner;
        uint64 deadline;
        Status status;
        bytes32 rulesHash;
        bytes32 resultHash;
    }

    /// @notice Time after the deadline in which an attempt met just before it can still be paid.
    uint64 public constant GRACE = 1 hours;
    /// @notice Safety rails for the deadline; the server offers 1 to 14 days inside them.
    uint64 public constant MIN_DURATION = 12 hours;
    uint64 public constant MAX_DURATION = 15 days;

    IERC20 public immutable usdc;
    address public evaluator;
    bool public resolvePaused;
    uint96 public minPrize;
    uint96 public maxPrize;
    /// @notice Sum of the prizes of every Open challenge.
    uint256 public totalOpen;
    uint256 public challengeCount;
    mapping(uint256 id => Challenge) private _challenges;

    event ChallengeCreated(
        uint256 indexed id, address indexed creator, uint96 prize, uint64 deadline, bytes32 rulesHash
    );
    event ChallengeResolved(uint256 indexed id, address indexed winner, uint96 prize, bytes32 resultHash);
    event ChallengeRefunded(uint256 indexed id, address indexed creator, uint96 prize);
    event EvaluatorChanged(address indexed previous, address indexed next);
    event ResolvePausedSet(bool paused);
    event PrizeLimitsSet(uint96 minPrize, uint96 maxPrize);

    error ZeroAddress();
    error EmptyRules();
    error PrizeOutOfRange();
    error DeadlineOutOfRange();
    error BadPrizeLimits();
    error NotEvaluator();
    error ResolveIsPaused();
    error NotOpen();
    error ResolveWindowClosed();
    error BadWinner();
    error TooEarly();
    error AmountMismatch();
    error RenounceDisabled();

    constructor(IERC20 usdc_, address owner_, address evaluator_, uint96 minPrize_, uint96 maxPrize_) Ownable(owner_) {
        if (address(usdc_) == address(0) || evaluator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        evaluator = evaluator_;
        _setPrizeLimits(minPrize_, maxPrize_);
        emit EvaluatorChanged(address(0), evaluator_);
    }

    // ---------------------------------------------------------------- create

    /// @notice Creates a challenge funded from the caller's approved USDC.
    function create(bytes32 rulesHash, uint96 prize, uint64 deadline) external nonReentrant returns (uint256 id) {
        id = _open(msg.sender, rulesHash, prize, deadline);
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), prize);
        if (usdc.balanceOf(address(this)) - before != prize) revert AmountMismatch();
    }

    // ---------------------------------------------------------------- settle

    /// @notice Pays the prize to the first player who met the goal.
    function resolve(uint256 id, address winner, bytes32 resultHash) external nonReentrant {
        if (msg.sender != evaluator) revert NotEvaluator();
        if (resolvePaused) revert ResolveIsPaused();
        Challenge storage c = _challenges[id];
        if (c.status != Status.Open) revert NotOpen();
        if (block.timestamp > uint256(c.deadline) + GRACE) revert ResolveWindowClosed();
        if (winner == address(0) || winner == c.creator) revert BadWinner();
        uint96 prize = c.prize;
        c.status = Status.Resolved;
        c.winner = winner;
        c.resultHash = resultHash;
        totalOpen -= prize;
        emit ChallengeResolved(id, winner, prize, resultHash);
        usdc.safeTransfer(winner, prize);
    }

    /// @notice Returns an unwon prize to its creator once the deadline and grace have passed.
    /// Anyone may call it, and pausing never blocks it.
    function refund(uint256 id) external nonReentrant {
        Challenge storage c = _challenges[id];
        if (c.status != Status.Open) revert NotOpen();
        if (block.timestamp <= uint256(c.deadline) + GRACE) revert TooEarly();
        uint96 prize = c.prize;
        c.status = Status.Refunded;
        totalOpen -= prize;
        emit ChallengeRefunded(id, c.creator, prize);
        usdc.safeTransfer(c.creator, prize);
    }

    // ---------------------------------------------------------------- owner

    function setEvaluator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit EvaluatorChanged(evaluator, next);
        evaluator = next;
    }

    function setResolvePaused(bool paused) external onlyOwner {
        resolvePaused = paused;
        emit ResolvePausedSet(paused);
    }

    function setPrizeLimits(uint96 minPrize_, uint96 maxPrize_) external onlyOwner {
        _setPrizeLimits(minPrize_, maxPrize_);
    }

    /// @notice Disabled: without an owner a compromised evaluator could never be replaced.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------- views

    function challenge(uint256 id) external view returns (Challenge memory) {
        return _challenges[id];
    }

    // ---------------------------------------------------------------- internal

    function _open(address creator, bytes32 rulesHash, uint96 prize, uint64 deadline) private returns (uint256 id) {
        if (rulesHash == bytes32(0)) revert EmptyRules();
        if (prize < minPrize || prize > maxPrize) revert PrizeOutOfRange();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) {
            revert DeadlineOutOfRange();
        }
        id = ++challengeCount;
        _challenges[id] = Challenge({
            creator: creator,
            prize: prize,
            winner: address(0),
            deadline: deadline,
            status: Status.Open,
            rulesHash: rulesHash,
            resultHash: bytes32(0)
        });
        totalOpen += prize;
        emit ChallengeCreated(id, creator, prize, deadline, rulesHash);
    }

    function _setPrizeLimits(uint96 minPrize_, uint96 maxPrize_) private {
        if (minPrize_ == 0 || minPrize_ > maxPrize_) revert BadPrizeLimits();
        minPrize = minPrize_;
        maxPrize = maxPrize_;
        emit PrizeLimitsSet(minPrize_, maxPrize_);
    }
}
