import Relic from "@relicprotocol/client";
import { ethers } from "ethers";
import { Provider } from "zksync-web3";
import dotenv from "dotenv";
dotenv.config();

const mainnetProvider = new ethers.providers.JsonRpcProvider(
  "https://rpc.flashbots.net/"
);

const mainnetSigner = new ethers.Wallet(
  process.env.ETHEREUM_PRIVATE_KEY as string
).connect(mainnetProvider);

const zkSyncProvider = new Provider("https://mainnet.era.zksync.io");

const relic = await Relic.RelicClient.fromProviders(
  zkSyncProvider,
  mainnetProvider
);

async function publishBlockHash(block: number, wait: boolean) {
  console.log(`Publishing block hash to Relic for block ${block}`);

  const blockHash = await mainnetProvider.getBlock(block).then((b) => b.hash);

  console.log("block hash", blockHash);

  const txData = await relic.bridge.sendBlock(blockHash);

  console.log("txData", txData);

  const tx = await mainnetSigner.sendTransaction(txData);

  console.log("tx", tx);

  if (wait) await relic.bridge.waitUntilBridged(blockHash);

  console.log(
    `Published block hash to Relic for block ${block} in tx ${tx.hash}`
  );
}

publishBlockHash(19008623, true);
