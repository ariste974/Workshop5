import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value, NodeState } from "../types";

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  const createInitialNodeState = (): NodeState => ({
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0
  });

  let nodeState: NodeState = createInitialNodeState();
  let phase1Messages: (Value | null)[] = Array(N).fill(null);
  let phase2Messages: (Value | null)[] = Array(N).fill(null);
  let receivedValues: (Value | null)[] = Array(N).fill(null);
  receivedValues[nodeId] = initialValue;

  const computeMajorityValue = (messages: (Value | null)[]) => {
    const counts = [0, 0];
    messages.forEach(msg => {
      if (msg !== null) {
        counts[msg as number]++;
      }
    });
    
    return counts[0] > (N - F) / 2 ? 0 
         : counts[1] > (N - F) / 2 ? 1 
         : 1; // default to 1 if no clear majority
  };

  const sendMessageToAll = async (phase: number, k: number, x: Value) => {
    const promises = [];
    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        promises.push(
          fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              senderId: nodeId, 
              value: { phase, k, x } 
            })
          })
        );
      }
    }
    await Promise.all(promises);
  };

  const resetMessagesForNewRound = () => {
    phase1Messages = Array(N).fill(null);
    phase2Messages = Array(N).fill(null);
  };

  // Status routes
  node.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
    return res; 
  });

  node.get("/getState", (req, res) => {
    return res.status(200).json(nodeState);
  });

  // Message handling route
  node.post("/message", (req, res) => {
    if (nodeState.killed || nodeState.decided) {
      return res.status(500).send("Node is killed or has decided");
    }

    if (isFaulty) {
      return res.status(200).send("Message received by faulty node");
    }

    const { senderId, value } = req.body;
    const { phase, k, x } = value;

    if (nodeState.k === k) {
      if (phase === 1) phase1Messages[senderId] = x;
      if (phase === 2) phase2Messages[senderId] = x;
    }

    return res.status(200).send("Message received");
  });

  // Consensus start route
  node.get("/start", async (req, res) => {
    if (isFaulty || nodeState.killed || nodeState.k == null || nodeState.x == null) {
      return res.status(500).send("Node is faulty or killed");
    }

    while (!nodeState.decided && !nodeState.killed && (nodeState.k ?? 0) <= 12) {
      nodeState.k = (nodeState.k ?? 0) + 1;
      resetMessagesForNewRound();

      // PHASE 1
      await sendMessageToAll(1, nodeState.k, nodeState.x);
      const majorityValue1 = computeMajorityValue(phase1Messages);

      // PHASE 2
      await sendMessageToAll(2, nodeState.k, majorityValue1);
      
      // Handle fault scenarios
      if ((F * 2) >= N) {
        nodeState.x = Math.floor(Math.random() * 2) as Value;
        continue;
      }

      // Determine final value
      const majorityValue2 = computeMajorityValue(phase2Messages);
      nodeState.x = majorityValue2;
      nodeState.decided = true;
    }

    return res.status(200).send("Consensus started");
  });

  // Stop route
  node.get("/stop", async (req, res) => {
    nodeState.killed = true;
    return res.status(200).send("Consensus stopped");
  });

  // Start server
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    setNodeIsReady(nodeId);
  });

  return server;
}