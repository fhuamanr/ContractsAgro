// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test Wrapped Bitcoin (tWBTC)
/// @notice Activo de prueba que replica el faucet de wBTC de los testnets (8 decimales).
contract TestWBTC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1 * 1e8; // 1 tWBTC por solicitud

    constructor() ERC20("Test Wrapped Bitcoin", "tWBTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @notice Faucet: entrega 1 tWBTC de prueba a quien lo solicite.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}

/// @title AgroTrace Lending
/// @notice Pool de prestamo con colateral inspirado en Aave v3:
///         deposito de colateral (tWBTC), oraculo de precios, LTV,
///         umbral de liquidacion, factor de salud, prestamo en AGT y repago.
contract AgroTraceLending is Ownable {
    IERC20 public immutable collateralToken; // tWBTC (8 decimales)
    IERC20 public immutable debtToken;       // AGT  (18 decimales)

    // Parametros de riesgo (en %)
    uint256 public constant LTV = 50;                   // se puede pedir hasta 50 % del valor del colateral
    uint256 public constant LIQUIDATION_THRESHOLD = 75; // si la deuda supera 75 % del colateral -> liquidable
    uint256 public constant LIQUIDATION_BONUS = 5;      // premio del liquidador

    // Oraculo simulado (precios en USD con 8 decimales, formato Chainlink)
    uint256 public collateralPriceUSD = 60_000 * 1e8; // 1 tWBTC = 60,000 USD
    uint256 public debtPriceUSD = 1 * 1e8;            // 1 AGT   = 1 USD

    mapping(address => uint256) public collateralOf; // en unidades de tWBTC
    mapping(address => uint256) public debtOf;       // en unidades de AGT

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event PriceUpdated(uint256 collateralPriceUSD, uint256 debtPriceUSD);

    constructor(address _collateralToken, address _debtToken) Ownable(msg.sender) {
        collateralToken = IERC20(_collateralToken);
        debtToken = IERC20(_debtToken);
    }

    // ===================== Oraculo =====================

    /// @notice Actualiza precios (simula un feed de Chainlink).
    function setPrices(uint256 _collateralPriceUSD, uint256 _debtPriceUSD) external onlyOwner {
        require(_collateralPriceUSD > 0 && _debtPriceUSD > 0, "Precio invalido");
        collateralPriceUSD = _collateralPriceUSD;
        debtPriceUSD = _debtPriceUSD;
        emit PriceUpdated(_collateralPriceUSD, _debtPriceUSD);
    }

    // ===================== Operaciones =====================

    /// @notice Deposita tWBTC como colateral (requiere approve previo).
    function depositCollateral(uint256 amount) external {
        require(amount > 0, "Monto debe ser mayor a cero");
        require(collateralToken.transferFrom(msg.sender, address(this), amount), "Transferencia fallida");
        collateralOf[msg.sender] += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Pide prestado AGT respetando el LTV.
    function borrow(uint256 amount) external {
        require(amount > 0, "Monto debe ser mayor a cero");
        require(amount <= maxBorrow(msg.sender), "Excede capacidad de prestamo (LTV 50%)");
        require(debtToken.balanceOf(address(this)) >= amount, "Liquidez insuficiente en el pool");
        debtOf[msg.sender] += amount;
        require(debtToken.transfer(msg.sender, amount), "Transferencia fallida");
        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repaga deuda en AGT (requiere approve previo).
    function repay(uint256 amount) external {
        require(amount > 0, "Monto debe ser mayor a cero");
        require(amount <= debtOf[msg.sender], "Monto mayor a la deuda");
        require(debtToken.transferFrom(msg.sender, address(this), amount), "Transferencia fallida");
        debtOf[msg.sender] -= amount;
        emit Repaid(msg.sender, amount);
    }

    /// @notice Retira colateral si la posicion sigue sana.
    function withdrawCollateral(uint256 amount) external {
        require(amount > 0 && amount <= collateralOf[msg.sender], "Monto invalido");
        collateralOf[msg.sender] -= amount;
        require(healthFactor(msg.sender) >= 100, "La posicion quedaria en riesgo");
        require(collateralToken.transfer(msg.sender, amount), "Transferencia fallida");
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Liquida una posicion con factor de salud < 1.00 pagando toda su deuda.
    function liquidate(address user) external {
        require(healthFactor(user) < 100, "Posicion sana: no liquidable");
        uint256 debt = debtOf[user];
        require(debtToken.transferFrom(msg.sender, address(this), debt), "Transferencia fallida");

        // colateral equivalente a la deuda + bonus del liquidador
        uint256 seized = (debt * debtPriceUSD * (100 + LIQUIDATION_BONUS)) / (100 * collateralPriceUSD * 1e10);
        if (seized > collateralOf[user]) seized = collateralOf[user];

        debtOf[user] = 0;
        collateralOf[user] -= seized;
        require(collateralToken.transfer(msg.sender, seized), "Transferencia fallida");
        emit Liquidated(user, msg.sender, debt, seized);
    }

    // ===================== Consultas =====================

    /// @notice Valor del colateral en USD (8 decimales).
    function collateralValueUSD(address user) public view returns (uint256) {
        return (collateralOf[user] * collateralPriceUSD) / 1e8;
    }

    /// @notice Valor de la deuda en USD (8 decimales).
    function debtValueUSD(address user) public view returns (uint256) {
        return (debtOf[user] * debtPriceUSD) / 1e18;
    }

    /// @notice AGT adicional que el usuario puede pedir segun el LTV.
    function maxBorrow(address user) public view returns (uint256) {
        uint256 limitUSD = (collateralValueUSD(user) * LTV) / 100;
        uint256 debtUSD = debtValueUSD(user);
        if (debtUSD >= limitUSD) return 0;
        return ((limitUSD - debtUSD) * 1e18) / debtPriceUSD;
    }

    /// @notice Factor de salud x100 (225 = 2.25). Menor a 100 = liquidable.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debtUSD = debtValueUSD(user);
        if (debtUSD == 0) return type(uint256).max;
        return (collateralValueUSD(user) * LIQUIDATION_THRESHOLD) / debtUSD;
    }

    /// @notice Resumen de la posicion para el panel del usuario.
    function getAccountData(address user)
        external view
        returns (
            uint256 collateralTWBTC,
            uint256 collateralUSD,
            uint256 debtAGT,
            uint256 debtUSD,
            uint256 availableToBorrowAGT,
            uint256 healthFactorX100
        )
    {
        return (
            collateralOf[user],
            collateralValueUSD(user),
            debtOf[user],
            debtValueUSD(user),
            maxBorrow(user),
            healthFactor(user)
        );
    }
}
