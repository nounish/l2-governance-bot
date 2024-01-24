import BotSwarm, { Task } from "@federationwtf/botswarm";
import {
  FederationNounsGovernor,
  FederationNounsRelayer,
  NounsDAOLogicV3,
} from "@federationwtf/botswarm/contracts";
import Relic from "@relicprotocol/client";
import { ethers } from "ethers";
import { Provider } from "zksync-web3";

const { Ethereum, log } = BotSwarm();

const mainnetProvider = new ethers.providers.JsonRpcProvider(
  "https://rpc.flashbots.net/"
);

const zkSyncProvider = new Provider("https://mainnet.era.zksync.io");

const relic = await Relic.RelicClient.fromProviders(
  zkSyncProvider,
  mainnetProvider
);

const { addTask, watch, read, clients, contracts, schedule } = Ethereum({
  contracts: {
    FederationNounsGovernor,
    FederationNounsRelayer,
    NounsDAOLogicV3,
  },
  hooks: {
    getBlockProof: async (task) => {
      log.active(`Getting block proof for block ${task.execute.args[1]}`);

      const { hash } = await clients.mainnet.getTransaction({
        blockNumber: task.execute.args[1],
        index: 0,
      });

      console.log("hash", hash);

      const receipt = await mainnetProvider.getTransactionReceipt(hash);

      console.log("receipt", receipt);

      const { proof } = await relic.transactionProver.getProofData(receipt);

      console.log("block proof", proof);

      const newTask = {
        ...task,
        execute: { ...task.execute, args: [task.execute.args[0], proof] },
      } satisfies Task;

      console.log("newTask", newTask);
      return newTask;
    },
  },
  privateKey: process.env.ETHEREUM_PRIVATE_KEY as string,
});

async function settleVotes(event: { args: { proposal: bigint } }) {
  const [, , , , , , , , , , , castWindow, finalityBlocks] = await read({
    contract: "FederationNounsGovernor",
    chain: "zkSync",
    functionName: "config",
  });

  const { endBlock } = await read({
    contract: "FederationNounsGovernor",
    chain: "zkSync",
    functionName: "getProposal",
    args: [event.args.proposal],
  });

  addTask({
    schedule: {
      block: endBlock - (castWindow + finalityBlocks) + 150n, // 150 blocks is ~30 minutes and finality is ~15 minutes
      chain: "mainnet",
    },
    execute: {
      hooks: ["getBlockProof"],
      contract: "FederationNounsGovernor",
      chain: "zkSync",
      functionName: "settleVotes",
      // @ts-ignore
      args: [event.args.proposal, endBlock - (castWindow + finalityBlocks)],
    },
  });
}

// settleVotes({ args: { proposal: 482n } });
settleVotes({ args: { proposal: 483n } });
