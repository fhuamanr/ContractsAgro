# AgroTrace — prototipo blockchain para trazabilidad agrícola (AGT)

Prototipo del proyecto de la UD **Diseño de Soluciones Blockchain** (Instituto Certus, 6.º ciclo).
Implementa el modelo AgroTrace: un token de utilidad ERC-20 (**AGT**) cuyo tokenomics recompensa
eventos verificables de la cadena de suministro, y un pool de préstamos con colateral (estilo
Aave v3) que permite a los exportadores obtener liquidez sin vender sus activos.

| Contrato | Archivo | Red / función |
|----------|---------|----------------|
| `AgroTraceToken` (AGT) | `contracts/AgroTraceToken.sol` | Token ERC-20 + trazabilidad de lotes + roles |
| `TestWBTC` (tWBTC) | `contracts/AgroTraceLending.sol` | Activo de prueba con faucet, 8 decimales |
| `AgroTraceLending` | `contracts/AgroTraceLending.sol` | Pool de préstamos: colateral, oráculo, LTV, liquidación |

## Componentes tecnológicos

- **Solidity ^0.8.20** (compilado en el proyecto con **0.8.34**), EVM paris.
- **OpenZeppelin Contracts 5.x**: `ERC20`, `ERC20Burnable`, `AccessControl`, `Ownable`.
- **Hardhat 2.29** como entorno de desarrollo, compilación, pruebas y despliegue.
- **ethers.js v6** para interactuar con los contratos.
- **Mocha + Chai + hardhat-chai-matchers** para la suite de pruebas.
- **Redes soportadas**: Hardhat Network (local, por defecto) y Sepolia (red de pruebas pública).

## Requisitos

```bash
npm install
```

## Pruebas

```bash
npx hardhat test
```

La suite incluye pruebas unitarias de cada contrato, pruebas negativas (roles, LTV, liquidez),
pruebas de límites (agotamiento de pools) y una **prueba de integración** que reproduce los
24 pasos del experimento del informe con los mismos valores esperados.

Para el reporte de gas por función:

```bash
REPORT_GAS=true npx hardhat test
```

## Replicar el experimento (24 pasos) sin Remix

```bash
npx hardhat run scripts/replicar_experimento.js
```

Ejecuta el ciclo completo (registro → recepción → auditoría → recompensas → colateral → préstamo →
rechazo por LTV → repago → caída de precio → liquidación) e imprime el resultado de cada paso.

## Despliegue

### Red local (Hardhat Network)

```bash
npx hardhat run scripts/deploy.js
```

### Red de pruebas pública (Sepolia)

```bash
export SEPOLIA_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
export DEPLOYER_PRIVATE_KEY="0x..."      # cuenta con ETH de prueba del faucet
npx hardhat run scripts/deploy.js --network sepolia
```

El script despliega los tres contratos, dota al pool con 50,000 AGT del fondo operativo e imprime
las direcciones para el informe.

## Estructura

```
contracts/   contratos Solidity del prototipo
test/        pruebas unitarias, negativas, de límites y de integración
scripts/     despliegue y replicación del experimento
```

## Parámetros del tokenomics

| Componente | Valor |
|------------|-------|
| Suministro total | 1,000,000 AGT (fijo, emisión única en el constructor) |
| Distribución | 35 % productores · 20 % auditores · 15 % cooperativas · 20 % fondo operativo · 10 % gobernanza |
| Recompensas | registro 100 AGT · recepción 50 AGT · auditoría 80 AGT · bono de calidad 20 AGT |
| Roles | `PRODUCER_ROLE`, `COOPERATIVE_ROLE`, `AUDITOR_ROLE`, `DEFAULT_ADMIN_ROLE` |
| Quema | `penalize()` (sanción por fraude) y `burn()` |

## Parámetros de riesgo del pool

| Parámetro | Valor |
|-----------|-------|
| LTV | 50 % |
| Umbral de liquidación | 75 % |
| Bono del liquidador | 5 % |
| Factor de salud | (colateral × 75 %) / deuda, expresado ×100 |
| Oráculo | precios en USD con 8 decimales (formato Chainlink) |
