// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AgroTrace Token (AGT)
/// @notice Token de incentivos para la trazabilidad agricola. Cada recompensa
///         sale de un pool definido en el tokenomics y solo se paga cuando
///         un actor autorizado registra un evento verificable de un lote.
contract AgroTraceToken is ERC20, ERC20Burnable, AccessControl {
    // ----- Roles del ecosistema -----
    bytes32 public constant PRODUCER_ROLE = keccak256("PRODUCER_ROLE");
    bytes32 public constant COOPERATIVE_ROLE = keccak256("COOPERATIVE_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    // ----- Tokenomics: suministro total fijo y distribucion -----
    uint256 public constant TOTAL_SUPPLY_CAP = 1_000_000 * 1e18;
    uint256 public constant PRODUCER_ALLOCATION = 350_000 * 1e18;   // 35 %
    uint256 public constant AUDITOR_ALLOCATION = 200_000 * 1e18;    // 20 %
    uint256 public constant COOPERATIVE_ALLOCATION = 150_000 * 1e18; // 15 %
    uint256 public constant OPERATIONS_ALLOCATION = 200_000 * 1e18;  // 20 %
    uint256 public constant GOVERNANCE_ALLOCATION = 100_000 * 1e18;  // 10 %

    // Saldos pendientes de cada pool (custodiados por el contrato)
    uint256 public producerPool;
    uint256 public auditorPool;
    uint256 public cooperativePool;
    uint256 public governanceReserve;

    // ----- Recompensas fijas por evento verificable -----
    uint256 public constant REWARD_REGISTER = 100 * 1e18;   // productor registra lote
    uint256 public constant REWARD_RECEPTION = 50 * 1e18;   // cooperativa confirma recepcion
    uint256 public constant REWARD_VALIDATION = 80 * 1e18;  // auditor valida calidad
    uint256 public constant BONUS_QUALITY = 20 * 1e18;      // bono al productor si el lote se aprueba

    // ----- Trazabilidad de lotes -----
    enum LotStatus { None, Registered, Received, Approved, Rejected }

    struct Lot {
        address producer;
        address cooperative;
        address auditor;
        bytes32 dataHash;   // hash de documentos off-chain (guia, certificados, fotos)
        LotStatus status;
        uint256 updatedAt;
    }

    mapping(bytes32 => Lot) private lots;
    uint256 public totalLots;

    event LotRegistered(string lotId, address indexed producer, bytes32 dataHash);
    event LotReceived(string lotId, address indexed cooperative);
    event LotValidated(string lotId, address indexed auditor, bool approved);
    event TraceReward(address indexed actor, uint256 amount, string reason);
    event ActorPenalized(address indexed actor, uint256 amount, string reason);

    /// @param treasury Cuenta del fondo operativo (recibe el 20 %).
    constructor(address treasury) ERC20("AgroTrace Token", "AGT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Fondo operativo: liquido para soporte, mejoras y liquidez del sistema
        _mint(treasury, OPERATIONS_ALLOCATION);

        // Pools de incentivos y reserva de gobernanza: custodiados por el contrato
        uint256 custodied = PRODUCER_ALLOCATION + AUDITOR_ALLOCATION
            + COOPERATIVE_ALLOCATION + GOVERNANCE_ALLOCATION;
        _mint(address(this), custodied);
        producerPool = PRODUCER_ALLOCATION;
        auditorPool = AUDITOR_ALLOCATION;
        cooperativePool = COOPERATIVE_ALLOCATION;
        governanceReserve = GOVERNANCE_ALLOCATION;

        assert(totalSupply() == TOTAL_SUPPLY_CAP);
    }

    /// @notice Asigna en una sola transaccion los roles de la demo.
    function setupRoles(address producer, address cooperative, address auditor)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _grantRole(PRODUCER_ROLE, producer);
        _grantRole(COOPERATIVE_ROLE, cooperative);
        _grantRole(AUDITOR_ROLE, auditor);
    }

    // ===================== Flujo de trazabilidad =====================

    /// @notice Paso 1: el productor registra un lote nuevo.
    function registerLot(string calldata lotId, bytes32 dataHash) external onlyRole(PRODUCER_ROLE) {
        bytes32 key = keccak256(bytes(lotId));
        require(lots[key].status == LotStatus.None, "Lote ya registrado");
        require(dataHash != bytes32(0), "Hash de datos requerido");

        lots[key] = Lot(msg.sender, address(0), address(0), dataHash, LotStatus.Registered, block.timestamp);
        totalLots++;
        emit LotRegistered(lotId, msg.sender, dataHash);

        _payReward(msg.sender, REWARD_REGISTER, 0, "Registro de lote");
    }

    /// @notice Paso 2: la cooperativa confirma la recepcion fisica del lote.
    function confirmReception(string calldata lotId) external onlyRole(COOPERATIVE_ROLE) {
        Lot storage lot = lots[keccak256(bytes(lotId))];
        require(lot.status == LotStatus.Registered, "Lote no esta pendiente de recepcion");
        require(msg.sender != lot.producer, "El productor no puede confirmar su propio lote");

        lot.cooperative = msg.sender;
        lot.status = LotStatus.Received;
        lot.updatedAt = block.timestamp;
        emit LotReceived(lotId, msg.sender);

        _payReward(msg.sender, REWARD_RECEPTION, 2, "Recepcion cooperativa");
    }

    /// @notice Paso 3: un auditor independiente valida la calidad.
    function validateQuality(string calldata lotId, bool approved) external onlyRole(AUDITOR_ROLE) {
        Lot storage lot = lots[keccak256(bytes(lotId))];
        require(lot.status == LotStatus.Received, "Lote no esta listo para auditoria");
        require(msg.sender != lot.producer && msg.sender != lot.cooperative, "Auditor no independiente");

        lot.auditor = msg.sender;
        lot.status = approved ? LotStatus.Approved : LotStatus.Rejected;
        lot.updatedAt = block.timestamp;
        emit LotValidated(lotId, msg.sender, approved);

        _payReward(msg.sender, REWARD_VALIDATION, 1, "Auditoria de calidad");
        if (approved) {
            _payReward(lot.producer, BONUS_QUALITY, 0, "Bono por lote aprobado");
        }
    }

    /// @notice Consulta publica del historial del lote (comprador / QR).
    function getLot(string calldata lotId)
        external view
        returns (address producer, address cooperative, address auditor, bytes32 dataHash, LotStatus status, uint256 updatedAt)
    {
        Lot memory l = lots[keccak256(bytes(lotId))];
        return (l.producer, l.cooperative, l.auditor, l.dataHash, l.status, l.updatedAt);
    }

    // ===================== Sanciones y gobernanza =====================

    /// @notice Quema tokens de un actor ante registros fraudulentos (reduce la oferta).
    function penalize(address actor, uint256 amount, string calldata reason) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _burn(actor, amount);
        emit ActorPenalized(actor, amount, reason);
    }

    /// @notice Libera parte de la reserva de gobernanza (p. ej. tras una votacion).
    function releaseGovernance(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount <= governanceReserve, "Reserva insuficiente");
        governanceReserve -= amount;
        _transfer(address(this), to, amount);
    }

    // ===================== Interno =====================

    /// @dev pool: 0 = productores, 1 = auditores, 2 = cooperativas
    function _payReward(address to, uint256 amount, uint8 pool, string memory reason) internal {
        if (pool == 0) {
            require(producerPool >= amount, "Pool de productores agotado");
            producerPool -= amount;
        } else if (pool == 1) {
            require(auditorPool >= amount, "Pool de auditores agotado");
            auditorPool -= amount;
        } else {
            require(cooperativePool >= amount, "Pool de cooperativas agotado");
            cooperativePool -= amount;
        }
        _transfer(address(this), to, amount);
        emit TraceReward(to, amount, reason);
    }
}
