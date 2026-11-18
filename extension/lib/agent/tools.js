/**
 * The action toolset. Small on purpose: five verbs that cover reading, clicking,
 * typing, choosing and moving, each addressed by a ref from read_page.
 */

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Read the page in the active tab: its visible text, headings, and interactive elements with refs (e1, e2…). Always call this before clicking or typing, and again after anything that changes the page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description:
        'Click one element by its ref from the most recent read_page. Refuse to guess: if you do not have a ref, call read_page first.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref like e12, from read_page.' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description:
        'Type text into a text field, textarea or editable region, by ref. Optionally submit afterwards — submitting always asks the user first.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Field ref from read_page.' },
          text: { type: 'string', description: 'Text to type. Replaces the field contents.' },
          submit: {
            type: 'boolean',
            description: 'Press Enter / submit the form after typing. Use only when the user asked to send or search.',
          },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: 'Choose an option in a dropdown, by ref, matching the option text or value.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Dropdown ref from read_page.' },
          value: { type: 'string', description: 'Option text or value to select.' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page up, down, to the top or to the bottom.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Open an http(s) address in the active tab. Use a full URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL.' },
        },
        required: ['url'],
      },
    },
  },
];

export function parseArguments(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, value: {}, message: 'Arguments were not an object.' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, value: {}, message: 'Arguments were not valid JSON.' };
  }
}

/** Tool names the executor understands; anything else is reported as unknown. */
export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));
