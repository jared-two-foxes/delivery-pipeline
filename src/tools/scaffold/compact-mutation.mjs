// Full responses are validated above and retained by native callers. The model only
// needs an acknowledgement after a mutation; full list is an explicit diagnostic query.
// `requirements` is an optional unmapped-requirements query result, attached so missing
// coverage is actionable straight after the mutation that caused it.
export function compactMutation(result, requirements) {
  if (!result.ok || ['list', 'summary', 'issue', 'select', 'design-select', 'requirements'].includes(result.operation)) return result;
  const f = result.data.feature, t = result.data.task;
  const coverage = requirements && {
    complete: requirements.coverage.complete,
    problems: requirements.coverage.problems,
    unmapped: requirements.requirements.map(r => ({ id: r.id, missing: r.missing })),
  };
  return { ok: true, operation: result.operation, feature_id: result.feature_id,
    ...(result.task_id ? { task_id: result.task_id } : {}),
    data: { schema_version: 3, phase: f?.workflow.phase,
      task_revision: f?.task_revision, status: t?.status ?? f?.tasks?.[result.task_id]?.status,
      ...(coverage ? { coverage } : {}),
      next_query: { operation: 'summary', feature_id: result.feature_id } } };
}
