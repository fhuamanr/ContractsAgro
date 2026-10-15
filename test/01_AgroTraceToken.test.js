// Pruebas unitarias del contrato AgroTraceToken (token AGT + trazabilidad de lotes)
// Ejecutar: npx hardhat test test/01_AgroTraceToken.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;                       // 1 AGT (18 decimales)
const AGT = (n) => BigInt(n) * ONE;
const HASH = ethers.keccak256(ethers.toUtf8Bytes("guia-de-remision-LOTE-CACAO-001"));
const LOT = "LOTE-CACAO-001";

async function deployFixture() {
  const [admin, producer, cooperative, auditor, exporter, outsider] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("AgroTraceToken");
  const token = await Token.deploy(admin.address);   // treasury = admin (fondo operativo)
  await token.waitForDeployment();
  await token.connect(admin).setupRoles(producer.address, cooperative.address, auditor.address);
  return { token, admin, producer, cooperative, auditor, exporter, outsider };
}

describe("AgroTraceToken - tokenomics y trazabilidad (AGT)", function () {
  describe("1. Despliegue e emisión única", function () {
    it("define nombre y símbolo del token", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("AgroTrace Token");
      expect(await token.symbol()).to.equal("AGT");
    });

    it("usa 18 decimales (estándar ERC-20)", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.decimals()).to.equal(18n);
    });

    it("acuña exactamente 1,000,000 AGT y nunca más", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(AGT(1_000_000));
      expect(await token.TOTAL_SUPPLY_CAP()).to.equal(AGT(1_000_000));
    });

    it("entrega el 20 % del fondo operativo a la tesorería", async function () {
      const { token, admin } = await loadFixture(deployFixture);
      expect(await token.balanceOf(admin.address)).to.equal(AGT(200_000));
    });

    it("custodia en el contrato el 80 % destinado a pools y gobernanza", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.balanceOf(await token.getAddress())).to.equal(AGT(800_000));
    });

    it("inicializa los pools del tokenomics con la distribución 35/20/15/10", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.producerPool()).to.equal(AGT(350_000));     // 35 %
      expect(await token.auditorPool()).to.equal(AGT(200_000));      // 20 %
      expect(await token.cooperativePool()).to.equal(AGT(150_000));  // 15 %
      expect(await token.governanceReserve()).to.equal(AGT(100_000)); // 10 %
    });

    it("asigna el rol de administrador a quien despliega", async function () {
      const { token, admin } = await loadFixture(deployFixture);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("no expone una función pública de acuñación", async function () {
      const { token } = await loadFixture(deployFixture);
      const abi = JSON.stringify(token.interface.fragments);
      expect(abi).to.not.include('"name":"mint"');
    });
  });

  describe("2. Roles del ecosistema", function () {
    it("setupRoles otorga los tres roles operativos", async function () {
      const { token, producer, cooperative, auditor } = await loadFixture(deployFixture);
      expect(await token.hasRole(await token.PRODUCER_ROLE(), producer.address)).to.equal(true);
      expect(await token.hasRole(await token.COOPERATIVE_ROLE(), cooperative.address)).to.equal(true);
      expect(await token.hasRole(await token.AUDITOR_ROLE(), auditor.address)).to.equal(true);
    });

    it("solo el administrador puede asignar roles", async function () {
      const { token, producer, cooperative, auditor, outsider } = await loadFixture(deployFixture);
      await expect(
        token.connect(outsider).setupRoles(producer.address, cooperative.address, auditor.address)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("una cuenta sin rol no puede registrarse a sí misma como productor", async function () {
      const { token, outsider } = await loadFixture(deployFixture);
      expect(await token.hasRole(await token.PRODUCER_ROLE(), outsider.address)).to.equal(false);
    });
  });

  describe("3. Registro del lote (evento verificable 1)", function () {
    it("paga 100 AGT al productor desde el pool de productores", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      expect(await token.balanceOf(producer.address)).to.equal(AGT(100));
      expect(await token.producerPool()).to.equal(AGT(350_000) - AGT(100));
    });

    it("emite los eventos LotRegistered y TraceReward", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await expect(token.connect(producer).registerLot(LOT, HASH))
        .to.emit(token, "LotRegistered").withArgs(LOT, producer.address, HASH)
        .and.to.emit(token, "TraceReward").withArgs(producer.address, AGT(100), "Registro de lote");
    });

    it("solo una cuenta con PRODUCER_ROLE puede registrar", async function () {
      const { token, cooperative } = await loadFixture(deployFixture);
      await expect(token.connect(cooperative).registerLot(LOT, HASH))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("rechaza un lote sin hash de documentos", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await expect(token.connect(producer).registerLot(LOT, ethers.ZeroHash))
        .to.be.revertedWith("Hash de datos requerido");
    });

    it("rechaza registrar dos veces el mismo lote", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await expect(token.connect(producer).registerLot(LOT, HASH))
        .to.be.revertedWith("Lote ya registrado");
    });

    it("incrementa el contador de lotes y deja el lote en estado Registered (1)", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      expect(await token.totalLots()).to.equal(1n);
      const lot = await token.getLot(LOT);
      expect(lot.producer).to.equal(producer.address);
      expect(lot.dataHash).to.equal(HASH);
      expect(lot.status).to.equal(1n); // Registered
    });
  });

  describe("4. Confirmación de recepción (evento verificable 2)", function () {
    it("paga 50 AGT a la cooperativa desde su pool", async function () {
      const { token, producer, cooperative } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await token.connect(cooperative).confirmReception(LOT);
      expect(await token.balanceOf(cooperative.address)).to.equal(AGT(50));
      expect(await token.cooperativePool()).to.equal(AGT(150_000) - AGT(50));
    });

    it("cambia el estado a Received (2)", async function () {
      const { token, producer, cooperative } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await token.connect(cooperative).confirmReception(LOT);
      const lot = await token.getLot(LOT);
      expect(lot.status).to.equal(2n);
      expect(lot.cooperative).to.equal(cooperative.address);
    });

    it("exige COOPERATIVE_ROLE", async function () {
      const { token, producer } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await expect(token.connect(producer).confirmReception(LOT))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("no permite confirmar un lote que no fue registrado", async function () {
      const { token, cooperative } = await loadFixture(deployFixture);
      await expect(token.connect(cooperative).confirmReception("LOTE-INEXISTENTE"))
        .to.be.revertedWith("Lote no esta pendiente de recepcion");
    });

    it("impide que el productor confirme su propio lote", async function () {
      const { token, producer, admin } = await loadFixture(deployFixture);
      await token.connect(admin).setupRoles(producer.address, producer.address, producer.address);
      await token.connect(producer).registerLot(LOT, HASH);
      await expect(token.connect(producer).confirmReception(LOT))
        .to.be.revertedWith("El productor no puede confirmar su propio lote");
    });
  });

  describe("5. Auditoría de calidad (evento verificable 3)", function () {
    async function receivedFixture() {
      const base = await deployFixture();
      await base.token.connect(base.producer).registerLot(LOT, HASH);
      await base.token.connect(base.cooperative).confirmReception(LOT);
      return base;
    }

    it("aprobado: paga 80 AGT al auditor y 20 de bono al productor", async function () {
      const { token, producer, auditor } = await loadFixture(receivedFixture);
      await token.connect(auditor).validateQuality(LOT, true);
      expect(await token.balanceOf(auditor.address)).to.equal(AGT(80));
      expect(await token.balanceOf(producer.address)).to.equal(AGT(120)); // 100 + 20 de bono
      expect(await token.auditorPool()).to.equal(AGT(200_000) - AGT(80));
      expect(await token.producerPool()).to.equal(AGT(350_000) - AGT(120));
    });

    it("aprobado: el lote queda en Approved (3)", async function () {
      const { token, auditor } = await loadFixture(receivedFixture);
      await token.connect(auditor).validateQuality(LOT, true);
      const lot = await token.getLot(LOT);
      expect(lot.status).to.equal(3n);
      expect(lot.auditor).to.equal(auditor.address);
    });

    it("rechazado: pasa a Rejected (4) y no paga bono", async function () {
      const { token, producer, auditor } = await loadFixture(receivedFixture);
      await token.connect(auditor).validateQuality(LOT, false);
      expect((await token.getLot(LOT)).status).to.equal(4n);
      expect(await token.balanceOf(producer.address)).to.equal(AGT(100));
      expect(await token.balanceOf(auditor.address)).to.equal(AGT(80));
    });

    it("exige AUDITOR_ROLE (prueba negativa del informe)", async function () {
      const { token, cooperative } = await loadFixture(receivedFixture);
      await expect(token.connect(cooperative).validateQuality(LOT, true))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("no permite auditar un lote que aún no fue recibido", async function () {
      const { token, producer, auditor } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await expect(token.connect(auditor).validateQuality(LOT, true))
        .to.be.revertedWith("Lote no esta listo para auditoria");
    });

    it("exige independencia del auditor (no puede ser productor ni cooperativa)", async function () {
      // el productor recibe también AUDITOR_ROLE: al intentar auditar su propio lote, el contrato lo rechaza
      const base = await deployFixture();
      await base.token.connect(base.admin).setupRoles(base.producer.address, base.cooperative.address, base.producer.address);
      await base.token.connect(base.producer).registerLot(LOT, HASH);
      await base.token.connect(base.cooperative).confirmReception(LOT);
      await expect(base.token.connect(base.producer).validateQuality(LOT, true))
        .to.be.revertedWith("Auditor no independiente");
    });
  });

  describe("6. Sanciones y gobernanza", function () {
    it("penalize() quema tokens del infractor y reduce el suministro", async function () {
      const { token, admin, producer } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await token.connect(admin).penalize(producer.address, AGT(20), "Registro fraudulento");
      expect(await token.balanceOf(producer.address)).to.equal(AGT(80));
      expect(await token.totalSupply()).to.equal(AGT(1_000_000) - AGT(20));
    });

    it("penalize() solo puede ejecutarlo el administrador", async function () {
      const { token, producer, outsider } = await loadFixture(deployFixture);
      await token.connect(producer).registerLot(LOT, HASH);
      await expect(token.connect(outsider).penalize(producer.address, AGT(20), "x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("releaseGovernance() libera reserva y emite el evento de recompensa", async function () {
      const { token, admin, outsider } = await loadFixture(deployFixture);
      await token.connect(admin).releaseGovernance(outsider.address, AGT(10_000));
      expect(await token.balanceOf(outsider.address)).to.equal(AGT(10_000));
      expect(await token.governanceReserve()).to.equal(AGT(90_000));
    });

    it("releaseGovernance() no puede exceder la reserva", async function () {
      const { token, admin, outsider } = await loadFixture(deployFixture);
      await expect(token.connect(admin).releaseGovernance(outsider.address, AGT(100_001)))
        .to.be.revertedWith("Reserva insuficiente");
    });
  });
});
