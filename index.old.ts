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
  process.env.MAINNET_RPC_URL
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
  const canUseBlock = await relic.blockHistory.canVerifyBlock(block);

  if (canUseBlock) {
    log.warn(`Block ${block} is already verified on Relic, skipping`);
    return;
  }

  log.active(`Publishing block hash to Relic for block ${block}`);

  const blockHash = await mainnetProvider.getBlock(block).then((b) => b.hash);

  console.log("block hash", blockHash);

  const txData = await relic.bridge.sendBlock(blockHash);

  console.log("txData", txData);

  const tx = await mainnetSigner.sendTransaction(txData);

  console.log("tx", tx);

  if (wait) await relic.bridge.waitUntilBridged(blockHash);

  log.success(
    `Published block hash to Relic for block ${block} in tx ${tx.hash}`
  );
}

const { addTask, watch, read, clients, contracts, schedule } = Ethereum({
  contracts: {
    FederationNounsGovernor,
    FederationNounsRelayer,
    NounsDAOLogicV3,
  },
  hooks: {
    getBlockProof: async (task) => {
      log.active(`Getting block proof for block ${task.execute.args[1]}`);

      // This takes like 15 min
      await publishBlockHash(Number(task.execute.args[1]), true);

      const { hash } = await clients.mainnet.getTransaction({
        blockNumber: task.execute.args[1],
        index: 0,
      });

      const receipt = await mainnetProvider.getTransactionReceipt(hash);

      const { proof } = await relic.transactionProver.getProofData(receipt);

      return {
        ...task,
        execute: { ...task.execute, args: [task.execute.args[0], proof] },
      } satisfies Task;
    },
    getMessageProof: async (task) => {
      const [transactionHash, encodedMessage] = task.execute.args;

      const { l1BatchNumber, l1BatchTxIndex, blockNumber } =
        await zkSyncProvider.getTransactionReceipt(transactionHash);

      console.log(l1BatchNumber, l1BatchTxIndex, blockNumber);

      const messageHash = ethers.utils.keccak256(encodedMessage);

      console.log("messageHash", messageHash);

      const proofInfo = await zkSyncProvider.getMessageProof(
        blockNumber,
        contracts.FederationNounsGovernor.deployments.zkSync,
        messageHash
      );

      console.log("proofInfo", proofInfo);

      if (!proofInfo) {
        throw new Error("No proof found");
      }

      return {
        ...task,
        execute: {
          ...task.execute,
          args: [
            l1BatchNumber,
            proofInfo.id,
            l1BatchTxIndex,
            encodedMessage,
            proofInfo.proof,
          ],
        },
      } satisfies Task;
    },
  },
  scripts: {
    publishBlockHash,
  },
  privateKey: process.env.ETHEREUM_PRIVATE_KEY as string,
});

// Publish proposal startBlock hash to Relic
watch(
  {
    contract: "NounsDAOLogicV3",
    chain: "mainnet",
    event: "ProposalCreated",
  },
  async (event) => {
    schedule({
      name: "publishBlockHash",
      block: Number(event.args.startBlock) + 150, // 150 blocks is ~30 minutes and finality is ~15 minutes
      chain: "mainnet",
      args: [Number(event.args.startBlock), false],
    });
  }
);

// Governor
clients.zkSync.watchContractEvent({
  abi: FederationNounsGovernor.abi,
  address: FederationNounsGovernor.deployments.zkSync,
  eventName: "VoteCast",
  onLogs: async (logs) => {
    for (const event of logs) {
      const [, , , , , , , , , , , castWindow, finalityBlocks] = await read({
        contract: "FederationNounsGovernor",
        chain: "zkSync",
        functionName: "config",
      });

      const { endBlock } = await read({
        contract: "FederationNounsGovernor",
        chain: "zkSync",
        functionName: "getProposal",
        args: [event.args.proposal ?? 0n],
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
  },
});

// Relayer
clients.zkSync.watchContractEvent({
  abi: FederationNounsGovernor.abi,
  address: FederationNounsGovernor.deployments.zkSync,
  eventName: "VotesSettled",
  onLogs: async (logs) => {
    for (const event of logs) {
      const [, , , , , , , , , , , , finalityBlocks] = await read({
        contract: "FederationNounsGovernor",
        chain: "zkSync",
        functionName: "config",
      });

      const encodedMessage = ethers.utils.AbiCoder.prototype.encode(
        ["uint256", "uint256", "uint256", "uint256"],
        [
          Number(event.args.proposal),
          Number(event.args.forVotes),
          Number(event.args.againstVotes),
          Number(event.args.abstainVotes),
        ]
      ) as `0x${string}`;

      const currentBlockNumber = await clients["mainnet"].getBlockNumber();

      addTask({
        schedule: {
          block: currentBlockNumber + finalityBlocks,
          chain: "mainnet",
        },
        execute: {
          hooks: ["getMessageProof"],
          contract: "FederationNounsRelayer",
          chain: "mainnet",
          functionName: "relayVotes",
          // @ts-ignore
          args: [
            // @ts-ignore
            event.transactionHash,
            // @ts-ignore
            encodedMessage,
          ],
        },
      });
    }
  },
});
