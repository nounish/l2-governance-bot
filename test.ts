import { FederationNounsGovernor } from "@federationwtf/botswarm/contracts";
import { createPublicClient, http } from "viem";
import { zkSync } from "viem/chains";

const client = createPublicClient({
  chain: zkSync,
  transport: http(),
});

console.log("Watching for VoteCast events on FederationNounsGovernor");

client.watchContractEvent({
  abi: FederationNounsGovernor.abi,
  address: FederationNounsGovernor.deployments.zkSync,
  eventName: "VoteCast",
  onLogs: async (logs) => {
    for (const log of logs) {
      console.log(log);
      console.log(log.transactionHash);
    }
  },
});
