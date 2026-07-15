/**
 * @typedef {object} ModelCost
 * @property {number} input
 * @property {number} output
 * @property {number} [cache_read]
 * @property {number} [cache_write]
 */

/**
 * @typedef {object} ModelLimit
 * @property {number} context
 * @property {number} [input]
 * @property {number} output
 */

/**
 * @typedef {object} ModelModalities
 * @property {Array<"text"|"audio"|"image"|"video"|"pdf">} input
 * @property {Array<"text"|"audio"|"image"|"video"|"pdf">} output
 */

/**
 * @typedef {object} Model
 * @property {string} id
 * @property {string} name
 * @property {string} [family]
 * @property {boolean} attachment
 * @property {boolean} reasoning
 * @property {boolean} tool_call
 * @property {boolean} temperature
 * @property {boolean} [structured_output]
 * @property {string} [release_date]
 * @property {"alpha"|"beta"|"deprecated"} [status]
 * @property {ModelLimit} limit
 * @property {ModelModalities} [modalities]
 * @property {ModelCost} [cost]
 * @property {string} [npm]
 * @property {string} [api]
 * @property {unknown[]} [reasoning_options]
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name
 * @property {string[]} env
 * @property {string} [api]
 * @property {string} [npm]
 * @property {string} [doc]
 * @property {Record<string, Model>} models
 */

/**
 * @typedef {object} CatalogMeta
 * @property {string} source
 * @property {string} note
 * @property {string} fetchedAt
 * @property {number} providerCount
 * @property {number} modelCount
 */

export {};
