function planStepsByName(plan) {
  const steps = new Map();
  const visit = node => {
    const name = node?.["Node Type"];
    if (name) {
      const matches = steps.get(name) || [];
      matches.push(node.nodeId || null);
      steps.set(name, matches);
    }
    for (const child of node?.children || []) visit(child);
  };
  if (plan) visit(plan);
  return steps;
}

function processorName(value) {
  return value.replace(/\s*×\s*\d+.*$/, "").replace(/\s+\d+\s*→\s*\d+\s*$/, "").trim();
}

export function parsePipeline(input, plan) {
  if (typeof input !== "string") throw new TypeError("EXPLAIN PIPELINE must be text.");
  const planSteps = planStepsByName(plan);
  const linkedCounts = new Map();
  const parents = [];
  const stages = [];

  for (const rawLine of input.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const text = rawLine.trim();
    const marker = text.match(/^\((.+)\)$/);
    if (marker) {
      while (parents.length && parents.at(-1).indent >= indent) parents.pop();
      const name = marker[1];
      const index = linkedCounts.get(name) || 0;
      const matches = planSteps.get(name) || [];
      parents.push({ indent, name, planNode: matches[index] || null });
      linkedCounts.set(name, index + 1);
      continue;
    }

    while (parents.length && parents.at(-1).indent > indent) parents.pop();
    const owner = parents.at(-1) || null;
    const multiplier = text.match(/×\s*(\d+)/);
    const flow = text.match(/(?:×\s*\d+\s*)?(\d+)\s*→\s*(\d+)\s*$/);
    const processor = processorName(text);
    stages.push({
      name: owner?.name || processor,
      processor,
      threads: multiplier ? Number(multiplier[1]) : 1,
      inputs: flow ? Number(flow[1]) : null,
      outputs: flow ? Number(flow[2]) : null,
      blocking: /(?:^|Merge)(?:Resize|Aggregat|Sort)|MergingSorted|MergeSorting/i.test(processor),
      planNode: owner?.planNode || null
    });
  }

  return { stages };
}
