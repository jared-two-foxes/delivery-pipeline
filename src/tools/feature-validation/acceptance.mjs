// Native entry point: record the user's acceptance of the feature's current checked/verified result.
import path from 'node:path';
import { git } from '../../lib/git/tree.mjs';
import { acceptFeatureResult } from '../../lib/verification/acceptance.mjs';
import { scaffoldFeatureOrNull, scaffoldTasks } from '../scaffold/adapter.mjs';
import { lifecycle } from './feature.mjs';

export async function acceptFeature(args, context = {}, options = {}) {
  // Only the Git repository root is needed to find Scaffold's state; the working tree's branch and
  // cleanliness are irrelevant, because acceptance is judged from the ledger alone.
  const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
  return acceptFeatureResult(args, {
    readFeature: async () => {
      const feature = await scaffoldFeatureOrNull(repository, args.featureId, options.scaffoldOptions);
      if (!feature) throw new Error('Unknown feature: ' + args.featureId);
      return feature;
    },
    store: async artifact => {
      const response = await scaffoldTasks({ operation: 'artifact-put', feature_id: args.featureId, payload: artifact },
        { directory: repository }, options.scaffoldOptions);
      if (!response.ok) throw new Error('Scaffold refused artifact-put: ' + response.message);
      return response.data.reference;
    },
    record: payload => lifecycle(repository, 'validation-accept', args.featureId, payload, options),
  }, context, options);
}
