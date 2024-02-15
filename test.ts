import { FederationNounsGovernor } from "@federationwtf/botswarm/contracts";
import { createPublicClient, http, parseAbiItem, parseEventLogs } from "viem";
import { zkSync } from "viem/chains";

import { Provider, utils, types } from "zksync-ethers";
import { ethers } from "ethers";

const client = createPublicClient({
  chain: zkSync,
  transport: http(),
});

// console.log("Watching for VoteCast events on FederationNounsGovernor");

// client.watchContractEvent({
//   abi: FederationNounsGovernor.abi,
//   address: FederationNounsGovernor.deployments.zkSync,
//   eventName: "VoteCast",
//   onLogs: async (logs) => {
//     for (const log of logs) {
//       console.log(log);
//       console.log(log.transactionHash);
//     }
//   },
// });

const provider = Provider.getDefaultProvider(types.Network.Mainnet);

console.log("Getting filter logs");

(async () => {
  // const logs = await client.getFilterLogs({
  //   filter: await client.createEventFilter({
  //     address: FederationNounsGovernor.deployments.zkSync,
  //     event: parseAbiItem(
  //       "event VotesSettled(uint256 proposal, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes)"
  //     ),
  //   }),
  // });

  const logs = await client.getLogs({
    address: "0x12A8924D3B8F96c6B13eEbd022c1414d0b537Ad9",
    event: parseAbiItem(
      "event VotesSettled(uint256 proposal, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes)"
    ),
    fromBlock: 0n,
    toBlock: await client.getBlockNumber(),
  });

  for (const log of logs) {
    const tx = await client.getTransactionReceipt({
      hash: log.transactionHash,
    });

    const events = parseEventLogs({
      abi: FederationNounsGovernor.abi,
      logs: tx.logs,
    });

    events.forEach((event) => {
      if (event.address === "0x12a8924d3b8f96c6b13eebd022c1414d0b537ad9") {
        if (event.eventName === "VotesSettled") {
          if (event.args.proposal === 500n) {
            console.log(event);
          }
        }
      }
    });
  }

  // const logs = await provider.getLogs({
  //   address: "0x12A8924D3B8F96c6B13eEbd022c1414d0b537Ad9",
  //   fromBlock: 0,
  //   toBlock: "latest",
  //   topics: [ethers.utils.id("VotesSettled(uint256,uint256,uint256,uint256)")],
  // });

  // console.log(logs);
})();
