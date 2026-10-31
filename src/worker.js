// Placeholder until the first release: the API answers 404.
import { DurableObject } from 'cloudflare:workers';

export class Poll extends DurableObject {}

export default {
  async fetch() {
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
