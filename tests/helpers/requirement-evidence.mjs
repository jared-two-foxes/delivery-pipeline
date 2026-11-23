// For tests that complete a task directly through Scaffold (rather than through the finalization tool):
// record the requirement evidence Scaffold requires first, for every role the task holds.
import { scaffoldTasks } from "../../src/tools/scaffold/adapter.mjs";
import { requirementBinding, taskRoles } from "../../src/lib/verification/requirements.mjs";

export async function recordTaskRequirementEvidence(dir, featureId, taskId, receipt, tree, { basis = "independent-review" } = {}) {
  const call = async (operation, payload, task_id) => {
    const response = await scaffoldTasks({ operation, feature_id: featureId, ...(task_id ? { task_id } : {}),
      ...(payload !== undefined ? { payload } : {}) }, { directory: dir });
    if (!response.ok) throw new Error("Scaffold " + operation + " failed: " + JSON.stringify(response));
    return response.data;
  };
  const feature = (await call("list")).feature;
  // Default: the tree Scaffold recorded for the attempt with this receipt.
  tree ??= feature.tasks[taskId].attempts.find((a) => a.receipt === receipt).tree;
  const design = feature.tasks[taskId].designs.at(-1).reference;
  const recorded = [];
  for (const r of (await call("issue", undefined, taskId)).context.requirements)
    for (const role of taskRoles(r, taskId)) {
      const binding = requirementBinding(r.id, r);
      const { reference } = await call("artifact-put", { fixture: "requirement-evidence", task: taskId, requirement: r.id, role, receipt, tree });
      await call("evidence-record", { feature_id: featureId, instance_id: feature.workflow.instance_id, requirement: r.id, role,
        result: "PASSED", basis, receipt, tree, binding, design, reference }, taskId);
      recorded.push({ requirement: r.id, role, reference });
    }
  return recorded;
}
