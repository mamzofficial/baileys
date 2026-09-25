import * as boom_1 from '@hapi/boom'
import * as WABinary_1 from '../WABinary/index.js'
export const wMexQuery = (variables, queryId, query, generateMessageTag) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: WABinary_1.S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = (0, WABinary_1.getBinaryNodeChild)(result, 'result')
	if (child?.content) {
		// Hardened against baileys@6.2.7: strip stray leading NUL bytes /
		// whitespace some server responses include, and don't let a
		// malformed-JSON response throw an *uncaught* SyntaxError here —
		// fall through to the generic "unexpected response structure" error
		// below instead, same as any other unrecognized response shape.
		const str = child.content.toString('utf-8').replace(/^\x00+/, '').trim();
		let data;
		try {
			data = JSON.parse(str);
		}
		catch {
			data = str;
		}
		if (typeof data === 'string') {
			return data;
		}
		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new boom_1.Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}
		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response
		}
	}
	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new boom_1.Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}