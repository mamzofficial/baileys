/**
 * lib/Utils/check-whatsapp-ban.js
 *
 * OPT-IN utility to check a WhatsApp number's ban/safety status via a
 * THIRD-PARTY, UNOFFICIAL API (kyuux-r.indevs.in). This is NOT a WhatsApp
 * endpoint, NOT operated by Baileys/WhiskeySockets, and NOT verified or
 * controlled by this package's maintainers.
 *
 * IMPORTANT — read before using:
 *  - This function makes an outbound HTTP request to a third-party domain
 *    that this library does not own or control. It is only ever called
 *    when YOU explicitly call it — nothing in Baileys calls this
 *    automatically, on install, on connect, or in the background.
 *  - The phone number you pass is sent to that third-party server. Don't
 *    pass numbers you don't have the right to share, and don't rely on
 *    this for anything sensitive — the service's accuracy, uptime, data
 *    handling and privacy practices are outside Baileys' control.
 *  - If the endpoint is down, changes shape, or disappears, this function
 *    will throw or return unexpected data. It's a convenience wrapper, not
 *    a guaranteed API.
 */

import { Boom } from '@hapi/boom';

const DEFAULT_CHECK_WHATSAPP_BAN_ENDPOINT = 'https://kyuux-r.indevs.in/api/check-whatsapp';

/**
 * Check a WhatsApp number's status using an unofficial third-party checker API.
 * Opt-in only — you must call this yourself, it is never invoked internally.
 *
 * @param {string} phone - phone number in international format, digits only (e.g. "6281578031233"), no leading '+'.
 * @param {object} [options]
 * @param {string} [options.endpoint] - override the checker endpoint if needed.
 * @param {number} [options.timeoutMs=10000] - abort the request after this many ms.
 * @returns {Promise<{success: boolean, data?: {number: string, status: string, banned: boolean, info?: {device?: string, email?: string}}, raw: any}>}
 */
export const checkWhatsAppBanStatus = async (phone, options = {}) => {
	if (!phone || typeof phone !== 'string') {
		throw new Boom('phone is required and must be a string (digits only, no "+")', { statusCode: 400 })
	}

	const normalizedPhone = phone.replace(/[^0-9]/g, '')
	if (!normalizedPhone) {
		throw new Boom('phone did not contain any digits after normalization', { statusCode: 400 })
	}

	const endpoint = options.endpoint || DEFAULT_CHECK_WHATSAPP_BAN_ENDPOINT
	const timeoutMs = options.timeoutMs ?? 10_000

	const url = `${endpoint}?phone=${encodeURIComponent(normalizedPhone)}`

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			signal: controller.signal
		})

		if (!response.ok) {
			throw new Boom(`check-whatsapp-ban request failed with status ${response.status}`, {
				statusCode: response.status
			})
		}

		const raw = await response.json()

		return {
			success: !!raw?.success,
			data: raw?.data,
			raw
		}
	} finally {
		clearTimeout(timeout)
	}
}
