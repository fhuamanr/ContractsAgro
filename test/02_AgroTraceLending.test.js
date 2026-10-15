// Pruebas unitarias de AgroTraceLending (TestWBTC + pool de préstamos estilo Aave v3)
// Ejecutar: npx hardhat test test/02_AgroTraceLending.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;                 // 1 AGT (18 decimales)
const ONE8 = 10n ** 8n;                 // 1 tWBTC (8 decimales)
const AGT = (n) => ethers.parseUnits(String(n), 18);
const WBTC = (n) => ethers.parseUnits(String(n), 8);

const PRICE_WBTC = 60_000n * ONE8;      // 60,000 USD con 8 decimales (formato Chainlink)
const PRICE_WBTC_CAIDA = 12_000n * ONE8;
const PRICE_AGT = 1n * ONE8;

async function deployFixture() {
  const [admin, producer, cooperative, auditor, exporter, liquidador] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("AgroTraceToken");
  const agt = await Token.deploy(admin.address);
  await agt.waitForDeployment();

  const WBTC = await ethers.getContractFactory("TestWBTC");
  const twbtc = await WBTC.deploy();
  await twbtc.waitForDeployment();

  const Lending = await ethers.getContractFactory("AgroTraceLending");
  const pool = await Lending.deploy(await twbtc.getAddress(), await agt.getAddress());
  await pool.waitForDeployment();

  // Liquidez del pool: 50,000 AGT del fondo operativo (paso 14 de la guía)
  await agt.connect(admin).transfer(await pool.getAddress(), AGT(50_000));

  return { agt, twbtc, pool, admin, producer, cooperative, auditor, exporter, liquidador };
}

// Fixture con la posición del exportador ya abierta: 0.1 tWBTC de colateral y 2,000 AGT de deuda
async function borrowedFixture() {
  const base = await deployFixture();
  await base.twbtc.connect(base.exporter).faucet();
  await base.twbtc.connect(base.exporter).approve(await base.pool.getAddress(), WBTC(0.1));
  await base.pool.connect(base.exporter).depositCollateral(WBTC(0.1));
  await base.pool.connect(base.exporter).borrow(AGT(2_000));
  return base;
}

// Fixture con la posición insolvente: precio del colateral caído a 12,000 USD
async function insolventFixture() {
  const base = await borrowedFixture();
  await base.agt.connect(base.exporter).approve(await base.pool.getAddress(), AGT(1_000));
  await base.pool.connect(base.exporter).repay(AGT(1_000));
  await base.pool.connect(base.admin).setPrices(PRICE_WBTC_CAIDA, PRICE_AGT);
  return base;
}

describe("AgroTraceLending - colateral, préstamo y riesgo", function () {
  describe("1. Activo de colateral TestWBTC", function () {
    it("define nombre, símbolo y 8 decimales como el wBTC real", async function () {
      const { twbtc } = await loadFixture(deployFixture);
      expect(await twbtc.name()).to.equal("Test Wrapped Bitcoin");
      expect(await twbtc.symbol()).to.equal("tWBTC");
      expect(await twbtc.decimals()).to.equal(8n);
    });

    it("el faucet entrega 1 tWBTC a quien lo solicita", async function () {
      const { twbtc, exporter } = await loadFixture(deployFixture);
      expect(await twbtc.balanceOf(exporter.address)).to.equal(0n);
      await twbtc.connect(exporter).faucet();
      expect(await twbtc.balanceOf(exporter.address)).to.equal(WBTC(1));
    });

    it("el faucet puede solicitarse desde varias cuentas", async function () {
      const { twbtc, exporter, liquidador } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(liquidador).faucet();
      expect(await twbtc.balanceOf(liquidador.address)).to.equal(WBTC(1));
    });
  });

  describe("2. Despliegue del pool", function () {
    it("registra los tokens de colateral y de deuda como inmutables", async function () {
      const { pool, twbtc, agt } = await loadFixture(deployFixture);
      expect(await pool.collateralToken()).to.equal(await twbtc.getAddress());
      expect(await pool.debtToken()).to.equal(await agt.getAddress());
    });

    it("define el owner y los parámetros de riesgo (LTV 50 %, umbral 75 %, bono 5 %)", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      expect(await pool.owner()).to.equal(admin.address);
      expect(await pool.LTV()).to.equal(50n);
      expect(await pool.LIQUIDATION_THRESHOLD()).to.equal(75n);
      expect(await pool.LIQUIDATION_BONUS()).to.equal(5n);
    });

    it("inicia el oráculo con 1 tWBTC = 60,000 USD y 1 AGT = 1 USD", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.collateralPriceUSD()).to.equal(PRICE_WBTC);
      expect(await pool.debtPriceUSD()).to.equal(PRICE_AGT);
    });

    it("el pool ya tiene 50,000 AGT de liquidez", async function () {
      const { pool, agt } = await loadFixture(deployFixture);
      expect(await agt.balanceOf(await pool.getAddress())).to.equal(AGT(50_000));
    });
  });

  describe("3. Oráculo de precios", function () {
    it("solo el owner puede actualizar precios", async function () {
      const { pool, exporter } = await loadFixture(deployFixture);
      await expect(pool.connect(exporter).setPrices(PRICE_WBTC_CAIDA, PRICE_AGT))
        .to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("rechaza precios iguales a cero", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setPrices(0, PRICE_AGT)).to.be.revertedWith("Precio invalido");
    });

    it("emite PriceUpdated al cambiar un precio", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setPrices(PRICE_WBTC_CAIDA, PRICE_AGT))
        .to.emit(pool, "PriceUpdated").withArgs(PRICE_WBTC_CAIDA, PRICE_AGT);
    });
  });

  describe("4. Depósito de colateral", function () {
    it("falla si no se autorizó antes al pool (regla ERC-20)", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await expect(pool.connect(exporter).depositCollateral(WBTC(0.1)))
        .to.be.revertedWithCustomError(twbtc, "ERC20InsufficientAllowance");
    });

    it("deposita 0.1 tWBTC y los custodia en el pool", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      expect(await pool.collateralOf(exporter.address)).to.equal(WBTC(0.1));
      expect(await twbtc.balanceOf(await pool.getAddress())).to.equal(WBTC(0.1));
    });

    it("rechaza depósitos de monto cero", async function () {
      const { pool, exporter } = await loadFixture(deployFixture);
      await expect(pool.connect(exporter).depositCollateral(0))
        .to.be.revertedWith("Monto debe ser mayor a cero");
    });

    it("valora el colateral en 6,000 USD", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      expect(await pool.collateralValueUSD(exporter.address)).to.equal(6_000n * ONE8);
    });

    it("permite retirar colateral si la posición no queda en riesgo", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      await pool.connect(exporter).withdrawCollateral(WBTC(0.05));
      expect(await pool.collateralOf(exporter.address)).to.equal(WBTC(0.05));
    });

    it("impide retirar colateral que dejaría la posición en riesgo", async function () {
      const { pool, exporter } = await loadFixture(borrowedFixture);
      await expect(pool.connect(exporter).withdrawCollateral(WBTC(0.1)))
        .to.be.revertedWith("La posicion quedaria en riesgo");
    });
  });

  describe("5. Préstamo (borrow)", function () {
    it("sin deuda el factor de salud es el máximo de uint256", async function () {
      const { pool, exporter } = await loadFixture(deployFixture);
      expect(await pool.healthFactor(exporter.address)).to.equal(2n ** 256n - 1n);
    });

    it("la capacidad inicial es de 3,000 AGT (50 % de 6,000 USD)", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      expect(await pool.maxBorrow(exporter.address)).to.equal(AGT(3_000));
    });

    it("entrega 2,000 AGT y registra la deuda", async function () {
      const { pool, agt, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      await pool.connect(exporter).borrow(AGT(2_000));
      expect(await agt.balanceOf(exporter.address)).to.equal(AGT(2_000));
      expect(await pool.debtOf(exporter.address)).to.equal(AGT(2_000));
    });

    it("rechaza un préstamo que supera el LTV del 50 %", async function () {
      const { pool, exporter } = await loadFixture(borrowedFixture);
      await expect(pool.connect(exporter).borrow(AGT(2_000)))
        .to.be.revertedWith("Excede capacidad de prestamo (LTV 50%)");
    });

    it("rechaza un préstamo mayor a la liquidez disponible del pool", async function () {
      // pool con solo 1,000 AGT de liquidez: el colateral alcanza para pedir 3,000 AGT
      const { agt, twbtc, admin, exporter } = await loadFixture(deployFixture);
      const Lending = await ethers.getContractFactory("AgroTraceLending");
      const pool2 = await Lending.deploy(await twbtc.getAddress(), await agt.getAddress());
      await pool2.waitForDeployment();
      await agt.connect(admin).transfer(await pool2.getAddress(), AGT(1_000));
      expect(await agt.balanceOf(await pool2.getAddress())).to.equal(AGT(1_000));

      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool2.getAddress(), WBTC(0.1));
      await pool2.connect(exporter).depositCollateral(WBTC(0.1));

      expect(await pool2.maxBorrow(exporter.address)).to.equal(AGT(3_000));
      await expect(pool2.connect(exporter).borrow(AGT(2_000)))
        .to.be.revertedWith("Liquidez insuficiente en el pool");
    });

    it("reduce la capacidad disponible a 1,000 AGT tras el préstamo", async function () {
      const { pool, exporter } = await loadFixture(borrowedFixture);
      expect(await pool.maxBorrow(exporter.address)).to.equal(AGT(1_000));
    });

    it("el factor de salud tras el préstamo es 2.25 (225)", async function () {
      const { pool, exporter } = await loadFixture(borrowedFixture);
      expect(await pool.healthFactor(exporter.address)).to.equal(225n);
    });

    it("emite el evento Borrowed", async function () {
      const { pool, twbtc, exporter } = await loadFixture(deployFixture);
      await twbtc.connect(exporter).faucet();
      await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
      await pool.connect(exporter).depositCollateral(WBTC(0.1));
      await expect(pool.connect(exporter).borrow(AGT(2_000)))
        .to.emit(pool, "Borrowed").withArgs(exporter.address, AGT(2_000));
    });
  });

  describe("6. Repago (repay)", function () {
    it("no permite repagar más que la deuda", async function () {
      const { pool, agt, exporter } = await loadFixture(borrowedFixture);
      await agt.connect(exporter).approve(await pool.getAddress(), AGT(3_000));
      await expect(pool.connect(exporter).repay(AGT(3_000)))
        .to.be.revertedWith("Monto mayor a la deuda");
    });

    it("repaga 1,000 AGT y mejora el factor de salud a 4.50 (450)", async function () {
      const { pool, agt, exporter } = await loadFixture(borrowedFixture);
      await agt.connect(exporter).approve(await pool.getAddress(), AGT(1_000));
      await pool.connect(exporter).repay(AGT(1_000));
      expect(await pool.debtOf(exporter.address)).to.equal(AGT(1_000));
      expect(await pool.healthFactor(exporter.address)).to.equal(450n);
    });

    it("devuelve la liquidez al pool y libera capacidad", async function () {
      const { pool, agt, exporter } = await loadFixture(borrowedFixture);
      const antes = await agt.balanceOf(await pool.getAddress());
      await agt.connect(exporter).approve(await pool.getAddress(), AGT(1_000));
      await pool.connect(exporter).repay(AGT(1_000));
      expect(await agt.balanceOf(await pool.getAddress())).to.equal(antes + AGT(1_000));
      expect(await pool.maxBorrow(exporter.address)).to.equal(AGT(2_000));
    });
  });

  describe("7. Caída de precio y liquidación", function () {
    it("la caída a 12,000 USD deja el factor de salud en 0.90 (90)", async function () {
      const { pool, exporter } = await loadFixture(insolventFixture);
      expect(await pool.collateralValueUSD(exporter.address)).to.equal(1_200n * ONE8);
      expect(await pool.healthFactor(exporter.address)).to.equal(90n);
    });

    it("no se puede liquidar una posición sana", async function () {
      const { pool, liquidador, exporter } = await loadFixture(borrowedFixture);
      await expect(pool.connect(liquidador).liquidate(exporter.address))
        .to.be.revertedWith("Posicion sana: no liquidable");
    });

    it("liquidate() cobra la deuda al liquidador y le entrega colateral con 5 % de bono", async function () {
      const { pool, agt, twbtc, exporter, liquidador, admin } = await loadFixture(insolventFixture);
      // el liquidador necesita AGT para pagar la deuda (lo toma del fondo operativo de la tesorería)
      await agt.connect(admin).transfer(liquidador.address, AGT(1_000));
      await agt.connect(liquidador).approve(await pool.getAddress(), AGT(1_000));
      const saldoAntes = await twbtc.balanceOf(liquidador.address);

      await pool.connect(liquidador).liquidate(exporter.address);

      // 1,000 AGT de deuda + 5 % de bono = 1,050 USD -> 0.0875 tWBTC
      expect(await twbtc.balanceOf(liquidador.address)).to.equal(saldoAntes + 8_750_000n);
      expect(await pool.debtOf(exporter.address)).to.equal(0n);
      expect(await pool.collateralOf(exporter.address)).to.equal(1_250_000n); // 0.0125 tWBTC
      // el pool recupera exactamente su liquidez inicial: 50,000 - 2,000 (préstamo) + 1,000 (repago) + 1,000 (liquidación)
      expect(await agt.balanceOf(await pool.getAddress())).to.equal(AGT(50_000));
    });

    it("emite el evento Liquidated con la deuda y el colateral incautado", async function () {
      const { pool, agt, exporter, liquidador, admin } = await loadFixture(insolventFixture);
      await agt.connect(admin).transfer(liquidador.address, AGT(1_000));
      await agt.connect(liquidador).approve(await pool.getAddress(), AGT(1_000));
      await expect(pool.connect(liquidador).liquidate(exporter.address))
        .to.emit(pool, "Liquidated").withArgs(exporter.address, liquidador.address, AGT(1_000), 8_750_000n);
    });
  });

  describe("8. Consulta de la posición (getAccountData)", function () {
    it("resume colateral, deuda, disponible y factor de salud", async function () {
      const { pool, exporter } = await loadFixture(borrowedFixture);
      const data = await pool.getAccountData(exporter.address);
      expect(data.collateralTWBTC).to.equal(WBTC(0.1));
      expect(data.collateralUSD).to.equal(6_000n * ONE8);
      expect(data.debtAGT).to.equal(AGT(2_000));
      expect(data.debtUSD).to.equal(2_000n * ONE8);
      expect(data.availableToBorrowAGT).to.equal(AGT(1_000));
      expect(data.healthFactorX100).to.equal(225n);
    });
  });
});
