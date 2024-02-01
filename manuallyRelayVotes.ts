import BotSwarm, { Task } from "@federationwtf/botswarm";
import {
  FederationNounsGovernor,
  FederationNounsRelayer,
  NounsDAOLogicV3,
} from "@federationwtf/botswarm/contracts";
import { ethers } from "ethers";
import { Provider } from "zksync-web3";

const { Ethereum } = BotSwarm();

const zkSyncProvider = new Provider("https://mainnet.era.zksync.io");

const { addTask, read, clients, contracts } = Ethereum({
  contracts: {
    FederationNounsGovernor,
    FederationNounsRelayer,
    NounsDAOLogicV3,
  },
  hooks: {
    getMessageProof: async (task) => {
      const messageHash = ethers.utils.keccak256(task.execute.args[3]);

      console.log("messageHash", messageHash);

      const proofInfo = await zkSyncProvider.getMessageProof(
        task.execute.args[5],
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
            task.execute.args[0],
            proofInfo.id,
            task.execute.args[2],
            task.execute.args[3],
            proofInfo.proof,
          ],
        },
      } satisfies Task;
    },
  },
  privateKey: process.env.ETHEREUM_PRIVATE_KEY as string,
});

async function relayVotes(event: {
  args: {
    proposal: number;
    forVotes: number;
    againstVotes: number;
    abstainVotes: number;
  };
  transactionHash: string;
}) {
  const [, , , , , , , , , , , , finalityBlocks] = await read({
    contract: "FederationNounsGovernor",
    chain: "zkSync",
    functionName: "config",
  });

  const { l1BatchNumber, l1BatchTxIndex, blockNumber } =
    await zkSyncProvider.getTransactionReceipt(event.transactionHash);

  const encodedMessage = ethers.utils.AbiCoder.prototype.encode(
    ["uint256", "uint256", "uint256", "uint256"],
    [
      Number(event.args.proposal),
      Number(event.args.forVotes),
      Number(event.args.againstVotes),
      Number(event.args.abstainVotes),
    ]
  ) as `0x${string}`;

  const proof = {
    id: 0n, // Overriden by hook
    proof: ["0xPROOF"], // Overriden by hook
  } as const;

  const currentBlockNumber = await clients["mainnet"].getBlockNumber();

  addTask({
    schedule: {
      block: currentBlockNumber - 100n,
      chain: "mainnet",
    },
    execute: {
      hooks: ["getMessageProof"],
      contract: "FederationNounsRelayer",
      chain: "mainnet",
      functionName: "relayVotes",
      args: [
        BigInt(l1BatchNumber),
        proof.id,
        l1BatchTxIndex,
        encodedMessage,
        proof.proof,
        //@ts-ignore
        blockNumber,
      ],
    },
  });
}

relayVotes({
  args: { proposal: 487, forVotes: 8, againstVotes: 0, abstainVotes: 10 },
  transactionHash:
    "0x0897554e6a5e5f0bf00b015ca0dec202a40b217deed3ac8356b9b60e68898b28",
});
