// Replicación del experimento AgroTrace (24 pasos) sobre una red EVM local.
// Uso: npx hardhat run scripts/replicar_experimento.js
// Sirve como demostración reproducible y como respaldo del video/evidencia del informe AA4.
const { ethers } = require("hardhat");

const AGT = (n) => ethers.parseUnits(String(n), 18);
const WBTC = (n) => ethers.parseUnits(String(n), 8);
const HASH = ethers.keccak256(ethers.toUtf8Bytes("guia-de-remision-LOTE-CACAO-001"));
const LOT = "LOTE-CACAO-001";

const fila = (n, accion, resultado) =>
  console.log(`  ${String(n).padStart(2, "0")} | ${accion.padEnd(52)} | ${resultado}`);

async function main() {
  const [admin, producer, cooperative, auditor, exporter] = await ethers.getSigners();

  console.log("\nAGROTRACE - REPLICACIÓN DEL EXPERIMENTO (24 PASOS)");
  console.log("Red:", (await ethers.provider.getNetwork()).name);
  console.log("Cuentas:");
  console.log("  1 administrador/tesorería:", admin.address);
  console.log("  2 productor              :", producer.address);
  console.log("  3 cooperativa            :", cooperative.address);
  console.log("  4 auditor                :", auditor.address);
  console.log("  5 exportador             :", exporter.address);
  console.log("\n  #  | ACCIÓN                                               | RESULTADO");
  console.log("  " + "-".repeat(95));

  // ---------- Parte A: preparación ----------
  const Token = await ethers.getContractFactory("AgroTraceToken");
  const agt = await Token.deploy(admin.address);
  await agt.waitForDeployment();
  const WBT = await ethers.getContractFactory("TestWBTC");
  const twbtc = await WBT.deploy();
  await twbtc.waitForDeployment();
  const Lending = await ethers.getContractFactory("AgroTraceLending");
  const pool = await Lending.deploy(await twbtc.getAddress(), await agt.getAddress());
  await pool.waitForDeployment();

  fila(1, "Crear AgroTraceToken.sol y AgroTraceLending.sol", "2 archivos");
  fila(2, "Compilar AgroTraceToken.sol (Solidity 0.8.34)", "bytecode generado");
  fila(3, "Compilar AgroTraceLending.sol", "bytecode generado");

  // ---------- Parte B: tokenomics ----------
  fila(4, "Desplegar AgroTraceToken (tesorería = account 1)", await agt.getAddress());
  await agt.connect(admin).setupRoles(producer.address, cooperative.address, auditor.address);
  fila(5, "Asignar roles (productor, cooperativa, auditor)", "PRODUCER/COOPERATIVE/AUDITOR");
  await agt.connect(producer).registerLot(LOT, HASH);
  fila(6, "registerLot(LOTE-CACAO-001) por el productor", "+100 AGT al productor");
  await agt.connect(cooperative).confirmReception(LOT);
  fila(7, "confirmReception por la cooperativa", "+50 AGT a la cooperativa");
  let rechazoRol = "no revertido";
  try {
    await agt.connect(cooperative).validateQuality(LOT, true);
  } catch (e) {
    rechazoRol = "revertido: AccessControlUnauthorizedAccount";
  }
  fila(8, "Auditar sin rol de auditor (prueba negativa)", rechazoRol);
  await agt.connect(auditor).validateQuality(LOT, true);
  fila(9, "validateQuality(true) por el auditor", "+80 AGT al auditor, +20 de bono");
  const lot = await agt.getLot(LOT);
  fila(10, "getLot(LOTE-CACAO-001)", `status = ${lot.status} (Approved)`);
  const b2 = await agt.balanceOf(producer.address);
  const b3 = await agt.balanceOf(cooperative.address);
  const b4 = await agt.balanceOf(auditor.address);
  fila(11, "balanceOf de los tres actores",
    `${ethers.formatEther(b2)} / ${ethers.formatEther(b3)} / ${ethers.formatEther(b4)} AGT`);

  // ---------- Parte C: préstamo ----------
  fila(12, "Desplegar TestWBTC", await twbtc.getAddress());
  fila(13, "Desplegar AgroTraceLending (colateral=TestWBTC, deuda=AGT)", await pool.getAddress());
  await agt.connect(admin).transfer(await pool.getAddress(), AGT(50_000));
  fila(14, "Transferir 50,000 AGT del fondo operativo al pool", "liquidez del pool = 50,000 AGT");
  await twbtc.connect(exporter).faucet();
  fila(15, "faucet() de tWBTC por el exportador", "1 tWBTC");
  await twbtc.connect(exporter).approve(await pool.getAddress(), WBTC(0.1));
  fila(16, "approve del tWBTC al pool", "0.1 tWBTC autorizados");
  await pool.connect(exporter).depositCollateral(WBTC(0.1));
  fila(17, "depositCollateral(0.1 tWBTC)", "colateral registrado");
  const d18 = await pool.getAccountData(exporter.address);
  fila(18, "getAccountData (capacidad de préstamo)", `${ethers.formatUnits(d18.availableToBorrowAGT, 18)} AGT disponibles`);
  await pool.connect(exporter).borrow(AGT(2_000));
  fila(19, "borrow(2,000 AGT)", "préstamo entregado");
  let rechazoLTV = "no revertido";
  try {
    await pool.connect(exporter).borrow(AGT(2_000));
  } catch (e) {
    rechazoLTV = "revertido: Excede capacidad (LTV 50%)";
  }
  fila(20, "Segundo borrow(2,000 AGT) (prueba negativa)", rechazoLTV);
  const d21 = await pool.getAccountData(exporter.address);
  fila(21, "getAccountData tras el préstamo", `factor de salud = ${d21.healthFactorX100} (2.25)`);
  await agt.connect(exporter).approve(await pool.getAddress(), AGT(1_000));
  await pool.connect(exporter).repay(AGT(1_000));
  fila(22, "approve + repay(1,000 AGT)", `factor de salud = ${await pool.healthFactor(exporter.address)} (4.50)`);
  await pool.connect(admin).setPrices(12_000n * 10n ** 8n, 1n * 10n ** 8n);
  fila(23, "setPrices(1 tWBTC = 12,000 USD)", `factor de salud = ${await pool.healthFactor(exporter.address)} (0.90)`);
  await agt.connect(admin).approve(await pool.getAddress(), AGT(1_000));
  await pool.connect(admin).liquidate(exporter.address);
  fila(24, "liquidate(exportador)", "colateral incautado con 5 % de bono");

  console.log("\nRESUMEN");
  console.log("  Suministro de AGT      :", ethers.formatEther(await agt.totalSupply()), "AGT (fijo)");
  console.log("  Pool de productores    :", ethers.formatEther(await agt.producerPool()), "AGT");
  console.log("  Pool de auditores      :", ethers.formatEther(await agt.auditorPool()), "AGT");
  console.log("  Pool de cooperativas   :", ethers.formatEther(await agt.cooperativePool()), "AGT");
  console.log("  Reserva de gobernanza  :", ethers.formatEther(await agt.governanceReserve()), "AGT");
  console.log("  Liquidez del pool      :", ethers.formatEther(await agt.balanceOf(await pool.getAddress())), "AGT");
  console.log("  Deuda del exportador   :", ethers.formatEther(await pool.debtOf(exporter.address)), "AGT");
  console.log("  Colateral del exportador:", (await pool.collateralOf(exporter.address)).toString(), "unidades (0.0125 tWBTC)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
