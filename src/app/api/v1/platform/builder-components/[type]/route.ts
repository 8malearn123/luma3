import { platformRoute } from '@/server/domains/platform/guard';
import { setComponent } from '@/server/domains/platform/templates';
import { componentInput } from '@/shared/schemas/platform';
import { Errors } from '@/server/http/errors';

/** PUT /api/v1/platform/builder-components/:type — enable/disable a builder block type. */
export const PUT = platformRoute({
  platformCapability: 'platform.templates.manage', input: componentInput,
  handler: async ({ params, actor, input }) => {
    const type = params.type;
    if (!type || !/^[a-z_]{2,40}$/.test(type)) throw Errors.notFound('component');
    return { data: await setComponent(type, actor, input) };
  },
});
