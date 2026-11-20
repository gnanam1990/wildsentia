// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 `receiveWithAuthorization` with the signature as bytes (Circle FiatToken v2.2).
interface IReceiveWithAuthorization {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @title Wildsentia Challenges
/// @notice A creator locks a USDC prize behind a goal. The evaluator pays it to the first player
/// to meet the goal; if nobody does by the deadline, anyone can return it to the creator.
/// A locked prize can only ever go to a winner who is not the creator, or back to the creator.
/// Each challenge keeps the evaluator it was created under. The owner can appoint the evaluator
/// for new challenges, pause payouts and set prize limits, but cannot move escrowed funds.
///
/// Version 2 (the security audit of 17 November 2026, finding C1), as the bounty contract's version 2
/// did: a stolen evaluator key is bounded. Prizes paid in one UTC day are capped, a prize can be
/// paid only once its challenge has been open a minimum time (so a watcher can see it and the owner
/// can pause), the owner can revoke an evaluator for good (its open prizes can then be refunded at
/// once), and neither the evaluator nor the owner can be the winner.
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
        /// @notice The evaluator when the challenge was created; only it can pay this prize.
        address evaluator;
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

    /// @notice The longest the owner may make a challenge wait before it can be paid.
    uint64 public constant MAX_MIN_OPEN = 1 days;
    /// @notice The most that may be paid out in one UTC day (refunds do not count). At first one
    /// top prize; the owner may raise it, never below the top prize.
    uint256 public dailyPayoutCap;
    /// @notice How long a challenge must have been open before its prize can be paid (10 minutes at first).
    uint64 public minOpenSeconds;
    /// @notice The UTC day (timestamp / 1 days) `paidToday` counts.
    uint64 public paidDay;
    /// @notice Paid out on `paidDay`.
    uint256 public paidToday;
    /// @notice When each challenge was created.
    mapping(uint256 id => uint64) public createdAt;
    /// @notice Evaluators revoked for good: they can no longer pay, and their open prizes can be refunded.
    mapping(address evaluator => bool) public revoked;

    event ChallengeCreated(
        uint256 indexed id,
        address indexed creator,
        uint96 prize,
        uint64 deadline,
        bytes32 rulesHash,
        bytes32 indexed authNonce
    );
    event ChallengeResolved(uint256 indexed id, address indexed winner, uint96 prize, bytes32 resultHash);
    event ChallengeRefunded(uint256 indexed id, address indexed creator, uint96 prize);
    event EvaluatorChanged(address indexed previous, address indexed next);
    event ResolvePausedSet(bool paused);
    event PrizeLimitsSet(uint96 minPrize, uint96 maxPrize);
    event EvaluatorRevoked(address indexed evaluator);
    event DailyPayoutCapSet(uint256 cap);
    event MinOpenSecondsSet(uint64 seconds_);

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
    error Revoked();
    error DailyCapReached();
    error BadLimits();

    constructor(IERC20 usdc_, address owner_, address evaluator_, uint96 minPrize_, uint96 maxPrize_) Ownable(owner_) {
        if (address(usdc_) == address(0) || evaluator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        evaluator = evaluator_;
        _setPrizeLimits(minPrize_, maxPrize_);
        dailyPayoutCap = maxPrize_;
        minOpenSeconds = 10 minutes;
        emit EvaluatorChanged(address(0), evaluator_);
        emit DailyPayoutCapSet(maxPrize_);
        emit MinOpenSecondsSet(10 minutes);
    }

    // ---------------------------------------------------------------- create

    /// @notice Creates a challenge funded from the caller's approved USDC.
    function create(bytes32 rulesHash, uint96 prize, uint64 deadline) external nonReentrant returns (uint256 id) {
        id = _open(msg.sender, rulesHash, prize, deadline, bytes32(0));
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), prize);
        if (usdc.balanceOf(address(this)) - before != prize) revert AmountMismatch();
    }

    /// @notice The EIP-3009 nonce a creator signs for `createWithAuthorization`. It commits to every
    /// parameter, so a relayed authorization cannot be used to open a challenge with other terms.
    function authorizationNonce(address creator, bytes32 rulesHash, uint96 prize, uint64 deadline, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), creator, rulesHash, prize, deadline, salt));
    }

    /// @notice Creates a challenge funded by the creator's signed EIP-3009 authorization. Anyone may
    /// relay it; only the terms the creator signed can be opened.
    function createWithAuthorization(
        address creator,
        bytes32 rulesHash,
        uint96 prize,
        uint64 deadline,
        bytes32 salt,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant returns (uint256 id) {
        if (creator == address(0)) revert ZeroAddress();
        bytes32 nonce = authorizationNonce(creator, rulesHash, prize, deadline, salt);
        id = _open(creator, rulesHash, prize, deadline, nonce);
        uint256 before = usdc.balanceOf(address(this));
        IReceiveWithAuthorization(address(usdc))
            .receiveWithAuthorization(creator, address(this), prize, validAfter, validBefore, nonce, signature);
        if (usdc.balanceOf(address(this)) - before != prize) revert AmountMismatch();
    }

    // ---------------------------------------------------------------- settle

    /// @notice Pays the prize to the first player who met the goal. Only the challenge's own
    /// evaluator (recorded at creation), not revoked, once the challenge has been open
    /// `minOpenSeconds`, and within the day's payout cap.
    function resolve(uint256 id, address winner, bytes32 resultHash) external nonReentrant {
        Challenge storage c = _challenges[id];
        if (c.status != Status.Open) revert NotOpen();
        // Only the evaluator recorded at creation: a new owner-set evaluator cannot take prizes
        // that were locked before it was appointed.
        if (msg.sender != c.evaluator || revoked[msg.sender]) revert NotEvaluator();
        if (resolvePaused) revert ResolveIsPaused();
        if (block.timestamp > uint256(c.deadline) + GRACE) revert ResolveWindowClosed();
        if (block.timestamp < uint256(createdAt[id]) + minOpenSeconds) revert TooEarly();
        if (
            winner == address(0) || winner == c.creator || winner == address(this) || winner == c.evaluator
                || winner == evaluator || winner == owner()
        ) revert BadWinner();
        uint96 prize = c.prize;
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != paidDay) {
            paidDay = today;
            paidToday = 0;
        }
        if (paidToday + prize > dailyPayoutCap) revert DailyCapReached();
        paidToday += prize;
        c.status = Status.Resolved;
        c.winner = winner;
        c.resultHash = resultHash;
        totalOpen -= prize;
        emit ChallengeResolved(id, winner, prize, resultHash);
        usdc.safeTransfer(winner, prize);
    }

    /// @notice Returns an unwon prize to its creator once the deadline and grace have passed, or at
    /// once if its evaluator was revoked. Anyone may call it, and pausing never blocks it.
    function refund(uint256 id) external nonReentrant {
        Challenge storage c = _challenges[id];
        if (c.status != Status.Open) revert NotOpen();
        if (block.timestamp <= uint256(c.deadline) + GRACE && !revoked[c.evaluator]) revert TooEarly();
        uint96 prize = c.prize;
        c.status = Status.Refunded;
        totalOpen -= prize;
        emit ChallengeRefunded(id, c.creator, prize);
        usdc.safeTransfer(c.creator, prize);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Appoints the evaluator for challenges created from now on. Existing challenges keep
    /// theirs; if that key is compromised, pause payouts and let those prizes refund.
    function setEvaluator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (revoked[next]) revert Revoked();
        emit EvaluatorChanged(evaluator, next);
        evaluator = next;
    }

    /// @notice Revokes an evaluator for good, the current one or an earlier one: it can no longer pay,
    /// and its open prizes can be refunded to their creators at once. Revoking the current evaluator
    /// leaves new challenges unpayable until a new one is appointed.
    function revokeEvaluator(address who) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        revoked[who] = true;
        emit EvaluatorRevoked(who);
    }

    /// @notice At least the top prize, so any one prize can be paid.
    function setDailyPayoutCap(uint256 cap) external onlyOwner {
        if (cap < maxPrize) revert BadLimits();
        dailyPayoutCap = cap;
        emit DailyPayoutCapSet(cap);
    }

    function setMinOpenSeconds(uint64 seconds_) external onlyOwner {
        if (seconds_ > MAX_MIN_OPEN) revert BadLimits();
        minOpenSeconds = seconds_;
        emit MinOpenSecondsSet(seconds_);
    }

    function setResolvePaused(bool paused) external onlyOwner {
        resolvePaused = paused;
        emit ResolvePausedSet(paused);
    }

    /// @notice The top prize stays within the day's payout cap, so any one prize can be paid.
    function setPrizeLimits(uint96 minPrize_, uint96 maxPrize_) external onlyOwner {
        if (maxPrize_ > dailyPayoutCap) revert BadLimits();
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

    function _open(address creator, bytes32 rulesHash, uint96 prize, uint64 deadline, bytes32 authNonce)
        private
        returns (uint256 id)
    {
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
            resultHash: bytes32(0),
            evaluator: evaluator
        });
        createdAt[id] = uint64(block.timestamp);
        totalOpen += prize;
        emit ChallengeCreated(id, creator, prize, deadline, rulesHash, authNonce);
    }

    function _setPrizeLimits(uint96 minPrize_, uint96 maxPrize_) private {
        if (minPrize_ == 0 || minPrize_ > maxPrize_) revert BadPrizeLimits();
        minPrize = minPrize_;
        maxPrize = maxPrize_;
        emit PrizeLimitsSet(minPrize_, maxPrize_);
    }
}
