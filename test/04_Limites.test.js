// Prueba de límites: demuestra que cada recompensa sale de su pool y que el contrato
// rechaza pagar cuando el pool se agota (protección de la sostenibilidad del tokenomics).
// Ejecutar: npx hardhat test test/04_Limites.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;
const AGT = (n) => BigInt(n) * ONE;
const HASH = ethers.keccak256(ethers.toUtf8Bytes("guia-de-remision"));

describe("Límites de los pools del tokenomics", function () {
  it("agotado el pool de productores (350,000 AGT), rechaza nuevas recompensas", async function () {
    this.timeout(900000);
    const [admin, producer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AgroTraceToken");
    const token = await Token.deploy(admin.address);
    await token.waitForDeployment();
    await token.connect(admin).setupRoles(producer.address, producer.address, producer.address);

    const REGISTROS = 3_500;      // 350,000 AGT / 100 AGT por registro
    const LOTE = 100;             // tamaño de bloque, para no superar el gas límite de bloque

    await network.provider.send("evm_setAutomine", [false]);
    for (let i = 0; i < REGISTROS; i++) {
      await token.connect(producer).registerLot(`LOTE-${i}`, HASH, { gasLimit: 400000 });
      if ((i + 1) % LOTE === 0) {
        await network.provider.send("evm_mine");
      }
    }
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);

    expect(await token.producerPool()).to.equal(0n);
    expect(await token.balanceOf(producer.address)).to.equal(AGT(350_000));
    expect(await token.totalLots()).to.equal(BigInt(REGISTROS));

    await expect(token.connect(producer).registerLot("LOTE-FINAL", HASH))
      .to.be.revertedWith("Pool de productores agotado");
  });

  it("el suministro sigue siendo 1,000,000 AGT: las recompensas solo reparten lo ya emitido", async function () {
    const [admin, producer, cooperative, auditor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AgroTraceToken");
    const token = await Token.deploy(admin.address);
    await token.waitForDeployment();
    await token.connect(admin).setupRoles(producer.address, cooperative.address, auditor.address);

    for (let i = 0; i < 20; i++) {
      await token.connect(producer).registerLot(`LOTE-${i}`, HASH);
      await token.connect(cooperative).confirmReception(`LOTE-${i}`);
      await token.connect(auditor).validateQuality(`LOTE-${i}`, true);
    }

    const repartido = await token.balanceOf(producer.address) + await token.balanceOf(cooperative.address) + await token.balanceOf(auditor.address);
    expect(repartido).to.equal(AGT(20 * 250));                 // 250 AGT por lote aprobado
    expect(await token.totalSupply()).to.equal(AGT(1_000_000)); // sin inflación
  });
});
