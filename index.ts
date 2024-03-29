import BotSwarm, { Task } from "@federationwtf/botswarm";
import {
  FederationNounsGovernor,
  FederationNounsRelayer,
  NounsDAOLogicV3,
} from "@federationwtf/botswarm/contracts";
import Relic from "@relicprotocol/client";
import { ethers } from "ethers";
import { Provider } from "zksync-web3";
import { parseAbiItem, parseEventLogs } from "viem";

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
      const [proposalId] = task.execute.args;

      const event = await (async () => {
        const logs = await clients.zkSync.getLogs({
          address: contracts.FederationNounsGovernor.deployments.zkSync,
          event: parseAbiItem(
            "event VotesSettled(uint256 proposal, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes)"
          ),
          fromBlock: 0n,
          toBlock: await clients.zkSync.getBlockNumber(),
        });

        for (const log of logs) {
          const tx = await clients.zkSync.getTransactionReceipt({
            hash: log.transactionHash,
          });

          const events = parseEventLogs({
            abi: FederationNounsGovernor.abi,
            logs: tx.logs,
          });

          for (const event of events) {
            if (
              event.address ===
              contracts.FederationNounsGovernor.deployments.zkSync
            ) {
              if (event.eventName === "VotesSettled") {
                if (event.args.proposal === proposalId) {
                  return event;
                }
              }
            }
          }
        }
      })();

      if (!event) {
        throw new Error(`No log found for prop ${proposalId}`);
      }

      const encodedMessage = ethers.utils.AbiCoder.prototype.encode(
        ["uint256", "uint256", "uint256", "uint256"],
        [
          Number(event.args.proposal),
          Number(event.args.forVotes),
          Number(event.args.againstVotes),
          Number(event.args.abstainVotes),
        ]
      ) as `0x${string}`;

      const { l1BatchNumber, l1BatchTxIndex, blockNumber } =
        await zkSyncProvider.getTransactionReceipt(event.transactionHash);

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

watch(
  {
    contract: "NounsDAOLogicV3",
    chain: "mainnet",
    event: "ProposalCreated",
  },
  async (event) => {
    const [, , , , , , , , , , , castWindow, finalityBlocks] = await read({
      contract: "FederationNounsGovernor",
      chain: "zkSync",
      functionName: "config",
    });

    // Publish proposal startBlock hash to Relic
    schedule({
      name: "publishBlockHash",
      block: Number(event.args.startBlock) + 150, // 150 blocks is ~30 minutes and finality is ~15 minutes
      chain: "mainnet",
      args: [Number(event.args.startBlock), false],
    });

    // Settle votes on the governor
    addTask({
      schedule: {
        block: event.args.endBlock - (castWindow + finalityBlocks) + 150n, // 150 blocks is ~30 minutes and finality is ~15 minutes
        chain: "mainnet",
      },
      execute: {
        hooks: ["getBlockProof"],
        contract: "FederationNounsGovernor",
        chain: "zkSync",
        functionName: "settleVotes",
        args: [
          event.args.id,
          // @ts-ignore
          event.args.endBlock - (castWindow + finalityBlocks),
        ],
      },
    });

    // Relay votes to the DAO
    addTask({
      schedule: {
        block: event.args.endBlock - castWindow / 2n,
        chain: "mainnet",
      },
      execute: {
        hooks: ["getMessageProof"],
        contract: "FederationNounsRelayer",
        chain: "mainnet",
        functionName: "relayVotes",
        // @ts-ignore
        args: [event.args.id],
      },
    });
  }
);
