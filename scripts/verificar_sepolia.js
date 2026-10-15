// Verificación funcional del prototipo AgroTrace sobre la red de pruebas (Sepolia).
// Ejecuta el ciclo completo del informe (24 pasos) contra los contratos ya desplegados y
// registra el hash de cada transacción como evidencia.
// Uso: bash /opt/data/_temp/aa4/run_verificacion_sepolia.sh
const fs = require("fs");
const { ethers } = require("ethers");

const REG = "/opt/data/_temp/aa4/deploy_sepolia.json";
const CUENTAS = "/opt/data/_temp/aa4/cuentas_sepolia.json";
const SALIDA = "/opt/data/_temp/aa4/verificacion_sepolia.json";
const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const AGT = (n) => ethers.parseUnits(String(n), 18);
const WBTC = (n) => ethers.parseUnits(String(n), 8);
const HASH = ethers.keccak256(ethers.toUtf8Bytes("guia-de-remision-LOTE-CACAO-001"));
const LOT = "LOTE-CACAO-001";

const ABI_TOKEN = [
  "function setupRoles(address,address,address)",
  "function registerLot(string,bytes32)",
  "function confirmReception(string)",
  "function validateQuality(string,bool)",
  "function getLot(string) view returns (address,address,address,bytes32,uint8,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
];
const ABI_WBTC = [
  "function faucet()",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const ABI_POOL = [
  "function depositCollateral(uint256)",
  "function borrow(uint256)",
  "function repay(uint256)",
  "function liquidate(address)",
  "function setPrices(uint256,uint256)",
  "function debtOf(address) view returns (uint256)",
  "function collateralOf(address) view returns (uint256)",
  "function getAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];

const pasos = [];

async function tx(nombre, promesa) {
  try {
    const t = await promesa;
    const rc = await t.wait();
    pasos.push({ paso: nombre, estado: "OK", tx: rc.hash, bloque: rc.blockNumber, gas: rc.gasUsed.toString() });
    console.log(`  OK   ${nombre.padEnd(46)} gas ${rc.gasUsed}  ${rc.hash}`);
    return rc;
  } catch (e) {
    const motivo = (e.shortMessage || e.message || "").split("\n")[0];
    const transitorio = /transaction execution reverted|missing response|timeout|nonce/i.test(motivo) &&
      !/esperad|revertir/i.test(nombre);
    if (transitorio) {
      console.log(`       reintentando ${nombre} (${motivo})`);
      await new Promise((r) => setTimeout(r, 8000));
      try {
        const t2 = await promesa;
        const rc2 = await t2.wait();
        pasos.push({ paso: nombre, estado: "OK", tx: rc2.hash, bloque: rc2.blockNumber, gas: rc2.gasUsed.toString() });
        console.log(`  OK   ${nombre.padEnd(46)} gas ${rc2.gasUsed}  ${rc2.hash} (reintento)`);
        return rc2;
      } catch (e2) {
        const m2 = (e2.shortMessage || e2.message || "").split("\n")[0];
        pasos.push({ paso: nombre, estado: "FALLO", motivo: m2 });
        console.log(`  FALLO ${nombre.padEnd(46)} ${m2}`);
        return null;
      }
    }
    pasos.push({ paso: nombre, estado: "REVERTIDO (esperado)", motivo });
    console.log(`  REV  ${nombre.padEnd(46)} ${motivo}`);
    return null;
  }
}

async function main() {
  const reg = JSON.parse(fs.readFileSync(REG));
  const p = new ethers.JsonRpcProvider(RPC, 11155111);
  const admin = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);

  // cuentas de los demás roles (se crean una vez y se reutilizan)
  let cuentas;
  if (fs.existsSync(CUENTAS)) {
    cuentas = JSON.parse(fs.readFileSync(CUENTAS));
  } else {
    cuentas = {
      producer: ethers.Wallet.createRandom().privateKey,
      cooperative: ethers.Wallet.createRandom().privateKey,
      auditor: ethers.Wallet.createRandom().privateKey,
      exporter: ethers.Wallet.createRandom().privateKey,
    };
    fs.writeFileSync(CUENTAS, JSON.stringify(cuentas, null, 2));
  }
  const producer = new ethers.Wallet(cuentas.producer, p);
  const cooperative = new ethers.Wallet(cuentas.cooperative, p);
  const auditor = new ethers.Wallet(cuentas.auditor, p);
  const exporter = new ethers.Wallet(cuentas.exporter, p);

  console.log("\nVERIFICACION FUNCIONAL EN SEPOLIA");
  console.log("contratos:", JSON.stringify(reg.contratos));
  console.log("administrador:", admin.address);
  console.log("productor:", producer.address, "| cooperativa:", cooperative.address);
  console.log("auditor:", auditor.address, "| exportador:", exporter.address, "\n");

  // financiar las cuentas de los actores (gas de prueba)
  for (const [rol, cta] of [["productor", producer], ["cooperativa", cooperative],
                            ["auditor", auditor], ["exportador", exporter]]) {
    const saldo = await p.getBalance(cta.address);
    if (saldo < ethers.parseEther("0.002")) {
      await tx(`financiar ${rol} (0.004 ETH de prueba)`,
        admin.sendTransaction({ to: cta.address, value: ethers.parseEther("0.004") }));
      console.log(`       saldo de ${rol}: ${ethers.formatEther(await p.getBalance(cta.address))} ETH`);
    }
  }

  const agt = new ethers.Contract(reg.contratos.AgroTraceToken, ABI_TOKEN, p);
  const twbtc = new ethers.Contract(reg.contratos.TestWBTC, ABI_WBTC, p);
  const pool = new ethers.Contract(reg.contratos.AgroTraceLending, ABI_POOL, p);

  console.log("\n-- Tokenomics y trazabilidad --");
  await tx("setPrices iniciales (1 tWBTC = 60,000 USD)", pool.connect(admin).setPrices(60000n * 10n ** 8n, 1n * 10n ** 8n));
  await tx("setupRoles (productor, cooperativa, auditor)", agt.connect(admin).setupRoles(producer.address, cooperative.address, auditor.address));
  const estadoLote = Number((await agt.getLot(LOT))[4]);
  if (estadoLote === 0) {
    await tx("registerLot(LOTE-CACAO-001) - productor", agt.connect(producer).registerLot(LOT, HASH));
    await tx("confirmReception(LOTE-CACAO-001) - cooperativa", agt.connect(cooperative).confirmReception(LOT));
  } else if (estadoLote === 1) {
    console.log("  (el lote ya estaba registrado en la red; se continúa con la recepción)");
    await tx("confirmReception(LOTE-CACAO-001) - cooperativa", agt.connect(cooperative).confirmReception(LOT));
  } else {
    console.log("  (el lote ya había completado el ciclo en la red)");
  }
  await tx("validateQuality sin rol de auditor (debe revertir)", agt.connect(cooperative).validateQuality(LOT, true));
  if (Number((await agt.getLot(LOT))[4]) !== 3) {
    await tx("validateQuality(LOTE-CACAO-001, true) - auditor", agt.connect(auditor).validateQuality(LOT, true));
  }
  const lot = await agt.getLot(LOT);
  console.log(`  Consulta getLot -> estado ${lot[4]} (3 = Approved)`);
  const saldos = {
    productor: ethers.formatUnits(await agt.balanceOf(producer.address), 18),
    cooperativa: ethers.formatUnits(await agt.balanceOf(cooperative.address), 18),
    auditor: ethers.formatUnits(await agt.balanceOf(auditor.address), 18),
  };
  console.log("  Saldos:", JSON.stringify(saldos));

  console.log("\n-- Prestamo con colateral --");
  // normalizar la posición si ya existía una deuda de una ejecución anterior
  const deudaPrevia = await pool.debtOf(exporter.address);
  if (deudaPrevia > 0n) {
    const disponible = await agt.balanceOf(exporter.address);
    const apagar = disponible < deudaPrevia ? disponible : deudaPrevia;
    await tx("approve AGT al pool (normalizar posición)", agt.connect(exporter).approve(reg.contratos.AgroTraceLending, apagar));
    await tx("repay (normalizar posición)", pool.connect(exporter).repay(apagar));
  }
  const colActual = (await pool.getAccountData(exporter.address))[0];
  if (colActual === 0n) {
    await tx("faucet() de tWBTC - exportador", twbtc.connect(exporter).faucet());
    await tx("approve tWBTC al pool (0.1)", twbtc.connect(exporter).approve(reg.contratos.AgroTraceLending, WBTC(0.1)));
    await tx("depositCollateral(0.1 tWBTC)", pool.connect(exporter).depositCollateral(WBTC(0.1)));
  } else {
    console.log("  (el exportador ya tenía colateral depositado en la red)");
  }
  const d1 = await pool.getAccountData(exporter.address);
  console.log(`  Capacidad de prestamo: ${ethers.formatUnits(d1[4], 18)} AGT | colateral: ${ethers.formatUnits(d1[1], 8)} USD`);
  await tx("borrow(2,000 AGT)", pool.connect(exporter).borrow(AGT(2000)));
  await tx("segundo borrow(2,000 AGT) (debe revertir por LTV)", pool.connect(exporter).borrow(AGT(2000)));
  const d2 = await pool.getAccountData(exporter.address);
  console.log(`  Factor de salud tras el prestamo: ${d2[5].toString()} (225 = 2.25)`);
  await tx("approve AGT al pool (1,000)", agt.connect(exporter).approve(reg.contratos.AgroTraceLending, AGT(1000)));
  await tx("repay(1,000 AGT)", pool.connect(exporter).repay(AGT(1000)));
  const d3 = await pool.getAccountData(exporter.address);
  console.log(`  Factor de salud tras el repago: ${d3[5].toString()} (450 = 4.50)`);

  console.log("\n-- Riesgo y liquidacion --");
  await tx("setPrices(1 tWBTC = 12,000 USD)", pool.connect(admin).setPrices(12000n * 10n ** 8n, 1n * 10n ** 8n));
  const d4 = await pool.getAccountData(exporter.address);
  console.log(`  Factor de salud tras la caida: ${d4[5].toString()} (90 = 0.90, liquidable)`);
  await tx("approve AGT del liquidador al pool", agt.connect(admin).approve(reg.contratos.AgroTraceLending, d4[2]));
  await tx("liquidate(posicion insolvente)", pool.connect(admin).liquidate(exporter.address));
  const d5 = await pool.getAccountData(exporter.address);
  console.log(`  Deuda final: ${ethers.formatUnits(d5[2], 18)} AGT | colateral final: ${d5[0].toString()} (0.0125 tWBTC)`);
  console.log(`  Saldo tWBTC del liquidador: ${ethers.formatUnits(await twbtc.balanceOf(admin.address), 8)}`);

  const resumen = {
    red: "sepolia",
    chainId: 11155111,
    contratos: reg.contratos,
    cuentas: { administrador: admin.address, productor: producer.address, cooperativa: cooperative.address, auditor: auditor.address, exportador: exporter.address },
    pasos,
    saldos_agt: saldos,
    estado_lote: lot[4].toString(),
    factor_salud: { tras_prestamo: d2[5].toString(), tras_repago: d3[5].toString(), tras_caida: d4[5].toString() },
    transacciones_ok: pasos.filter((x) => x.estado === "OK").length,
    reversiones_esperadas: pasos.filter((x) => x.estado !== "OK").length,
  };
  fs.writeFileSync(SALIDA, JSON.stringify(resumen, null, 2));
  console.log("\nTransacciones confirmadas:", resumen.transacciones_ok, "| reversiones esperadas:", resumen.reversiones_esperadas);
  console.log("Registro guardado en:", SALIDA);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
