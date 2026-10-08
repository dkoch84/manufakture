// The shape of the agent review e2e fixture (e2e/agent-review.fixture.json), which
// agentReviewFixture.test.ts makes with a real session and checks in, and the placeholders that
// stand for the ids a run makes up. The e2e fills them with the ids of the branch it seeds.

/** What stands for each made-up id in the fixture's stored bundle. */
export const AGENT_REVIEW_PLACEHOLDERS = {
  document: '<document>',
  branch: '<branch>',
  baseVersion: '<base-version>',
  session: '<session>',
} as const;

export interface AgentReviewFixture {
  about: string;
  /** Main's document, which the agent branch started from. */
  base: { id: string } & Record<string, unknown>;
  clientName: string;
  /** The agent's batches as the session logged them, oldest first. */
  batches: { label: string; command: unknown }[];
  /** The stored bundle (`packages/session`'s `StoredBundle`), ids as placeholders. */
  record: { format: string; revision: number; note: string; bundle: unknown } & Record<
    string,
    unknown
  >;
  /** The bundle's images, by SHA-256, as base64. */
  images: Record<string, string>;
}
