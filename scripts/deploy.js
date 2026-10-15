// Despliegue del prototipo AgroTrace (AgroTraceToken + TestWBTC + AgroTraceLending).
// Uso local:  npx hardhat run scripts/deploy.js
// Uso en red de pruebas:
//   SEPOLIA_RPC_URL="https://..." DEPLOYER_PRIVATE_KEY="0x..." npx hardhat run scripts/deploy.js --network sepolia
const { ethers, network } = require("hardhat");

const AGT = (n) => BigInt(n) * 10n ** 18n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const red = network.name;
  console.log("=".repeat(64));
  console.log(`Despliegue del prototipo AgroTrace en la red: ${red}`);
  console.log("Cuenta que despliega (administrador y tesorería):", deployer.address);
  console.log("Saldo:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("=".repeat(64));

  const registro = { red, deployer: deployer.address, contratos: {}, transacciones: {}, gas: {} };

  // 1. Token AGT con el tokenomics (tesorería = cuenta que despliega)
  const Token = await ethers.getContractFactory("AgroTraceToken");
  const agt = await Token.deploy(deployer.address);
  const rc1 = await agt.deploymentTransaction().wait();
  await agt.waitForDeployment();
  console.log("1/4 AgroTraceToken (AGT)     :", await agt.getAddress());
  console.log("     tx:", rc1.hash, "| bloque:", rc1.blockNumber, "| gas:", rc1.gasUsed.toString());
  registro.contratos.AgroTraceToken = await agt.getAddress();
  registro.transacciones.AgroTraceToken = rc1.hash;
  registro.gas.AgroTraceToken = rc1.gasUsed.toString();

  // 2. Activo de colateral de prueba
  const WBTC = await ethers.getContractFactory("TestWBTC");
  const twbtc = await WBTC.deploy();
  const rc2 = await twbtc.deploymentTransaction().wait();
  await twbtc.waitForDeployment();
  console.log("2/4 TestWBTC (tWBTC)         :", await twbtc.getAddress());
  console.log("     tx:", rc2.hash, "| bloque:", rc2.blockNumber, "| gas:", rc2.gasUsed.toString());
  registro.contratos.TestWBTC = await twbtc.getAddress();
  registro.transacciones.TestWBTC = rc2.hash;
  registro.gas.TestWBTC = rc2.gasUsed.toString();

  // 3. Pool de préstamos (colateral tWBTC, deuda AGT)
  const Lending = await ethers.getContractFactory("AgroTraceLending");
  const pool = await Lending.deploy(await twbtc.getAddress(), await agt.getAddress());
  const rc3 = await pool.deploymentTransaction().wait();
  await pool.waitForDeployment();
  console.log("3/4 AgroTraceLending (pool)  :", await pool.getAddress());
  console.log("     tx:", rc3.hash, "| bloque:", rc3.blockNumber, "| gas:", rc3.gasUsed.toString());
  registro.contratos.AgroTraceLending = await pool.getAddress();
  registro.transacciones.AgroTraceLending = rc3.hash;
  registro.gas.AgroTraceLending = rc3.gasUsed.toString();

  // 4. Liquidez inicial del pool con el fondo operativo (20 % del suministro)
  const tx = await agt.transfer(await pool.getAddress(), AGT(50_000));
  const rc4 = await tx.wait();
  console.log("4/4 Liquidez del pool        : 50,000 AGT");
  console.log("     tx:", rc4.hash, "| gas:", rc4.gasUsed.toString());
  registro.transacciones.liquidezPool = rc4.hash;
  registro.gas.liquidezPool = rc4.gasUsed.toString();

  console.log("-".repeat(64));
  console.log("Suministro total :", ethers.formatUnits(await agt.totalSupply(), 18), "AGT");
  console.log("Tesorería        :", ethers.formatUnits(await agt.balanceOf(deployer.address), 18), "AGT");
  console.log("Custodia (pools) :", ethers.formatUnits(await agt.balanceOf(await agt.getAddress()), 18), "AGT");
  console.log("Liquidez del pool:", ethers.formatUnits(await agt.balanceOf(await pool.getAddress()), 18), "AGT");
  console.log("=".repeat(64));
  console.log("Direcciones para el informe:");
  console.log(JSON.stringify(registro, null, 2));

  const fs = require("fs");
  const salida = process.env.SALIDA_JSON || "/opt/data/_temp/aa4/deploy_result.json";
  fs.writeFileSync(salida, JSON.stringify(registro, null, 2));
  console.log("Registro guardado en:", salida);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
