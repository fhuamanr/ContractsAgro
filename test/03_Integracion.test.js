// Prueba de integración: reproduce el ciclo completo del informe AA3 (24 pasos)
// sobre una EVM local, con las mismas cuentas, montos y valores esperados.
// Ejecutar: npx hardhat test test/03_Integracion.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const ONE8 = 10n ** 8n;
const AGT = (n) => ethers.parseUnits(String(n), 18);
const WBTC = (n) => ethers.parseUnits(String(n), 8);
const HASH = ethers.keccak256(ethers.toUtf8Bytes("guia-de-remision-LOTE-CACAO-001"));
const LOT = "LOTE-CACAO-001";

describe("Integración - ciclo completo AgroTrace (tokenomics + préstamo)", function () {
  it("ejecuta los 24 pasos del experimento y devuelve los valores del informe", async function () {
    const [admin, producer, cooperative, auditor, exporter] = await ethers.getSigners();

    // ---------- Parte A: preparación (pasos 1-3) ----------
    const Token = await ethers.getContractFactory("AgroTraceToken");
    const agt = await Token.deploy(admin.address);
    await agt.waitForDeployment();
    const WBTCF = await ethers.getContractFactory("TestWBTC");
    const twbtc = await WBTCF.deploy();
    await twbtc.waitForDeployment();
    const Lending = await ethers.getContractFactory("AgroTraceLending");
    const pool = await Lending.deploy(await twbtc.getAddress(), await agt.getAddress());
    await pool.waitForDeployment();

    // ---------- Parte B: tokenomics y trazabilidad (pasos 4-11) ----------
    expect(await agt.totalSupply()).to.equal(AGT(1_000_000));          // paso 4
    await agt.connect(admin).setupRoles(producer.address, cooperative.address, auditor.address); // paso 5
    await agt.connect(producer).registerLot(LOT, HASH);                // paso 6
    await agt.connect(cooperative).confirmReception(LOT);              // paso 7

    // paso 8: prueba negativa de rol
    await expect(agt.connect(cooperative).validateQuality(LOT, true))
      .to.be.revertedWithCustomError(agt, "AccessControlUnauthorizedAccount");

    await agt.connect(auditor).validateQuality(LOT, true);             // paso 9
    const lot = await agt.getLot(LOT);
    expect(lot.status).to.equal(3n);                                   // paso 10: Approved
    expect(await agt.balanceOf(producer.address)).to.equal(AGT(120));  // paso 11
    expect(await agt.balanceOf(cooperative.address)).to.equal(AGT(50));
    expect(await agt.balanceOf(auditor.address)).to.equal(AGT(80));
    expect(await agt.producerPool()).to.equal(AGT(350_000) - AGT(120));
    expect(await agt.auditorPool()).to.equal(AGT(200_000) - AGT(80));
    expect(await agt.cooperativePool()).to.equal(AGT(150_000) - AGT(50));

    // ---------- Parte C: préstamo con colateral (pasos 12-24) ----------
    await agt.connect(admin).transfer(await pool.getAddress(), AGT(50_000));   // paso 14
    const s14 = await agt.balanceOf(await pool.getAddress());
    expect(s14).to.equal(AGT(50_000));

    await twbtc.connect(exporter).faucet();                                    // paso 15
    expect(await twbtc.balanceOf(exporter.address)).to.equal(WBTC(1));
    await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1)); // paso 16
    await pool.connect(exporter).depositCollateral(WBTC(0.1));                 // paso 17

    const d18 = await pool.getAccountData(exporter.address);                   // paso 18
    expect(d18.collateralUSD).to.equal(6_000n * ONE8);
    expect(d18.availableToBorrowAGT).to.equal(AGT(3_000));

    await pool.connect(exporter).borrow(AGT(2_000));                           // paso 19
    expect(await agt.balanceOf(exporter.address)).to.equal(AGT(2_000));

    await expect(pool.connect(exporter).borrow(AGT(2_000)))                    // paso 20
      .to.be.revertedWith("Excede capacidad de prestamo (LTV 50%)");

    const d21 = await pool.getAccountData(exporter.address);                   // paso 21
    expect(d21.healthFactorX100).to.equal(225n);
    expect(d21.availableToBorrowAGT).to.equal(AGT(1_000));

    await agt.connect(exporter).approve(await pool.getAddress(), AGT(1_000));  // paso 22
    await pool.connect(exporter).repay(AGT(1_000));
    expect(await pool.healthFactor(exporter.address)).to.equal(450n);

    await pool.connect(admin).setPrices(12_000n * ONE8, 1n * ONE8);            // paso 23
    expect(await pool.healthFactor(exporter.address)).to.equal(90n);

    await agt.connect(admin).approve(await pool.getAddress(), AGT(1_000));    // paso 24
    await pool.connect(admin).liquidate(exporter.address);
    expect(await pool.debtOf(exporter.address)).to.equal(0n);
    expect(await pool.collateralOf(exporter.address)).to.equal(1_250_000n);   // 0.0125 tWBTC
    expect(await twbtc.balanceOf(admin.address)).to.equal(8_750_000n);        // 0.0875 tWBTC

    // Invariantes finales del sistema
    expect(await agt.producerPool() + await agt.auditorPool() + await agt.cooperativePool() + await agt.governanceReserve())
      .to.equal(AGT(800_000) - AGT(250));
    expect(await agt.totalSupply()).to.equal(AGT(1_000_000));
  });
});
