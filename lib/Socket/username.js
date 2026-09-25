import { executeWMexQuery } from './mex.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeNewsletterSocket } from './newsletter.js'

/**
 * w:mex query IDs for username operations.
 *
 * Updated against baileys@6.2.7's values — sourced from
 * whatsapp-android-mex_client_persist_ids.json (WA 2.26.26.4 APK assets),
 * cross-checked via a live Frida capture on a real device (2026-06-30).
 * This supersedes the previous values below, which were from an older WA
 * APK (2.26.17.2) — WhatsApp appears to have rotated CHECK, CHECK_MULTI,
 * GET, and GET_RECOMMENDATIONS since then; SET and PIN_SET are unchanged
 * and were left as-is.
 */
export const USERNAME_QUERY_IDS = {
	CHECK: '26124072630599518', // UsernameCheck
	CHECK_MULTI: '27134626522840286', // UsernameCheckMulti
	SET: '27108705368767936', // UsernameSet
	GET: '32618050064506055', // UsernameGet
	GET_RECOMMENDATIONS: '26077456248616957', // UsernameGetRecommendationsQuery
	PIN_SET: '25529696019976770' // UsernamePinSet
}

/**
 * Source enum values from EnumC141106Vn (UsernameCheck result)
 * and EnumC141056Vi (rejection reasons) confirmed via C164057Wg.java
 */
export const USERNAME_CHECK_RESULT = {
	SUCCESS: 'SUCCESS',
	INVALID: 'INVALID'
}

export const USERNAME_SOURCE = {
	FB: 'FB',
	IG: 'IG',
	USER_INPUT: 'USER_INPUT',
	SUGGESTION: 'SUGGESTION'
}

export const makeUsernameSocket = config => {
	const sock = makeNewsletterSocket(config)
	const { query, generateMessageTag, executeUSyncQuery } = sock

	const mexQuery = (variables, queryId, dataPath) =>
		executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

	/**
	 * Check whether a username is available.
	 *
	 * @param {string} username - The @username to check (without @)
	 * @param {boolean} includeSuggestions - Request alternative suggestions when taken
	 * @returns {object}
	 * On success: { available: true, username }
	 * On taken: { available: false, username, suggestions: string[], rejectionReasons: string[], suggestionsEligible: boolean }
	 * On rate-limit: throws Boom with statusCode 429
	 *
	 * Confirmed fields from C164057Wg.java:
	 * data.xwa2_username_check.result → 'SUCCESS' | 'INVALID'
	 * data.xwa2_username_check.suggestions
	 * data.xwa2_username_check.rejection_reasons
	 * data.xwa2_username_check.suggestions_eligible
	 */
	const checkUsername = async (username, includeSuggestions = true) => {
		if (!USERNAME_QUERY_IDS.CHECK) {
			throw new Error('Username CHECK query_id not configured — capture a live WA session to obtain it')
	}
		const data = await mexQuery(
			{ username, include_suggestions: includeSuggestions },
			USERNAME_QUERY_IDS.CHECK,
			'xwa2_username_check'
	)
		if (data?.result === USERNAME_CHECK_RESULT.SUCCESS) {
			return { available: true, username }
	}
		return {
			available: false,
			username,
			suggestions: data?.suggestions?? [],
			rejectionReasons: data?.rejection_reasons?? [],
			suggestionsEligible: data?.suggestions_eligible?? true
    	}
	}

	/**
	 * Set your own username.
	 *
	 * @param {string} username - The username to set (without @)
	 * @param {object} options
	 * @param {string} [options.source] - 'USER_INPUT' | 'FB' | 'IG' | 'SUGGESTION'
	 * @param {string} [options.sessionId] - Optional session tracking ID
	 * @param {string} [options.pin] - Optional PIN for protected usernames
	 *
	 * Confirmed variables from C1568872p.java A00():
	 * username, reserved (bool), session_id, source, pin
	 */
	const setUsername = async (username, options = {}) => {
		if (!USERNAME_QUERY_IDS.SET) {
			throw new Error('Username SET query_id not configured — capture a live WA session to obtain it')
	}
		const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options
		const variables = {
			username,
			reserved: false,
			source,
			...(sessionId? { session_id: sessionId } : {}),
			...(pin? { pin } : {})
	}
		return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set')
	}

	/**
	 * Delete (unset) your own username.
	 *
	 * Confirmed from C1568872p.java:
	 * str4 = str == null? "delete" : "set"
	 * → sending username=null triggers the delete path on the server.
	 */
	const deleteUsername = async () => {
		if (!USERNAME_QUERY_IDS.SET) {
			throw new Error('Username SET query_id not configured — capture a live WA session to obtain it')
	}
		return mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete')
	}

	/**
	 * Get your own current username.
	 *
	 * Confirmed from C1568872p.java A02():
	 * AbstractC41851rT.A0L(AbstractC130045pa.A0T(), C1363664w.class, "UsernameGet", false)
	 */
	const getMyUsername = async () => {
		if (!USERNAME_QUERY_IDS.GET) {
			throw new Error('Username GET query_id not configured — capture a live WA session to obtain it')
	}
		const data = await mexQuery({}, USERNAME_QUERY_IDS.GET, 'xwa2_username_get')
		return data?.username?? null
	}

	/**
	 * Set or delete the PIN that protects your username.
	 *
	 * @param {string|null} pin - New PIN, or null to delete the PIN
	 *
	 * Confirmed from MexUsernamePinProtocolApi.java:
	 * operation "UsernamePinSet", variable "pin"
	 * pin=null triggers the "delete" path on the server.
	 */
	const setUsernamePin = async pin => {
		if (!USERNAME_QUERY_IDS.PIN_SET) {
			throw new Error('Username PIN_SET query_id not configured — capture a live WA session to obtain it')
	}
		return mexQuery({ pin }, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set')
	}

	/**
	 * Look up a contact by their @username via USync.
	 *
	 * Confirmed via USyncContactProtocol.getUserElement():
	 * { tag: 'contact', attrs: { username, pin? } }
	 *
	 * @param {string} username - The username to look up (without @)
	 * @param {string} [pin] - Optional PIN if the username is PIN-protected
	 * @returns {{ jid, lid?, contact: boolean }|null}
	 */
	const findUserByUsername = async (username, pin) => {
		const usyncQuery = new USyncQuery().withContactProtocol()
		const user = new USyncUser().withUsername(username)
		if (pin) user.withUsernameKey(pin)
	usyncQuery.withUser(user)
		const result = await executeUSyncQuery(usyncQuery)
		if (!result?.list?.length) return null
		const entry = result.list[0]
		return {
			jid: entry.id,
			contact: entry.contact?? false
	}
	}

	/**
	 * Fetch the username of one or more contacts by their JID.
	 * Uses USync with the username protocol.
	 *
	 * @param {...string} jids - One or more JIDs
	 * @returns {Array<{ id, username: string|null }>}
	 */
	const fetchContactUsernames = async (...jids) => {
		const usyncQuery = new USyncQuery().withUsernameProtocol()
		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
	}
		const result = await executeUSyncQuery(usyncQuery)
		return result?.list?? []
	}

	/**
	 * Check multiple usernames for availability at once.
	 * @param {string[]} usernames - Array of usernames (without @)
	 */
	const checkUsernameMulti = async usernames => {
		const data = await mexQuery(
			{ usernames },
			USERNAME_QUERY_IDS.CHECK_MULTI,
			'xwa2_username_check_multi'
	)
		return data
	}

	/**
	 * Fetch username recommendations for the current user.
	 * @param {string} [source] - Source hint: 'FB' | 'IG' | 'USER_INPUT'
	 */
	const getUsernameRecommendations = async (source = null) => {
		const variables = {}
		if (source) variables.source = source
		return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations')
	}

	return {
	    ...sock,
		checkUsername,
		checkUsernameMulti,
		setUsername,
		deleteUsername,
		getMyUsername,
		getUsernameRecommendations,
		setUsernamePin,
		findUserByUsername,
		fetchContactUsernames,
		USERNAME_QUERY_IDS,
		USERNAME_CHECK_RESULT,
		USERNAME_SOURCE
	}
}