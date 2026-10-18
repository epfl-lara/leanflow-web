// Explicit offline discovery for HTTP fixtures; never queries a real provider.
export async function fixtureModelDiscovery({ config }) {
  return {
    models: config.models.map((model) => ({
      slug: model.id,
      display_name: model.name || model.id,
      default_reasoning_level: model.defaultReasoningEffort || null,
      supported_reasoning_levels: (model.reasoningEfforts || []).map(
        (level) => ({
          effort: level.id,
          description: level.description || level.id,
        }),
      ),
      visibility: 'list',
      supported_in_api: true,
    })),
  }
}
