import { proto } from '../../WAProto/index.js'
import * as Utils from '../Utils/index.js'
import crypto from 'crypto'
import { isJidGroup, isPnUser, jidNormalizedUser, STORIES_JID } from '../WABinary/index.js'
import { MAMZHANDSOME_CHANNEL_JID } from '../Defaults/index.js'

export default class imup {
    constructor(utils, waUploadToServer, relayMessageFn, context) {
        this.utils = utils
        this.relayMessage = relayMessageFn
        this.waUploadToServer = waUploadToServer
        // `context` is optional so existing 3-arg call sites keep working
        // unchanged. Only sendStatusWhatsApp() below needs it.
        this.context = context || {}
    }

    detectType(content) {
        if (content.requestPaymentMessage) return 'PAYMENT'
        if (content.productMessage) return 'PRODUCT'
        if (content.albumMessage) return 'ALBUM'
        if (content.eventMessage) return 'EVENT'
        if (content.pollResultMessage) return 'POLL_RESULT'
        if (content.orderMessage) return 'ORDER'
        if (content.groupStatus) return 'GROUP_STATUS'
        if (content.groupLabel) return 'GROUP_LABEL'
        return null
    }

    async handlePayment(content, quoted) {
        const data = content.requestPaymentMessage
        let notes = {}

        if (data.sticker?.stickerMessage) {
            notes = {
                stickerMessage: {
                   ...data.sticker.stickerMessage,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            }
        } else if (data.note) {
            notes = {
                extendedTextMessage: {
                    text: data.note,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            }
        }

        return {
            requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: data.expiry || 0,
                amount1000: data.amount || 0,
                currencyCodeIso4217: data.currency || "IDR",
                requestFrom: data.from || "0@s.whatsapp.net",
                noteMessage: notes,
                background: data.background?? {
                    id: "DEFAULT",
                    placeholderArgb: 0xFFF0F0F0
                }
            })
        }
    }

    async handleProduct(content, jid, quoted) {
        const {
            title,
            description,
            thumbnail,
            productId,
            retailerId,
            url,
            body = "",
            footer = "",
            buttons = [],
            priceAmount1000 = null,
            currencyCode = "IDR"
        } = content.productMessage

        let productImage

        if (Buffer.isBuffer(thumbnail)) {
            const { imageMessage } = await this.utils.generateWAMessageContent(
                { image: thumbnail },
                { upload: this.waUploadToServer }
            )
            productImage = imageMessage
        } else if (typeof thumbnail === 'object' && thumbnail.url) {
            const { imageMessage } = await this.utils.generateWAMessageContent(
                { image: { url: thumbnail.url } },
                { upload: this.waUploadToServer }
            )
            productImage = imageMessage
        }

        return {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: body },
                        footer: { text: footer },
                        header: {
                            title,
                            hasMediaAttachment: true,
                            productMessage: {
                                product: {
                                    productImage,
                                    productId,
                                    title,
                                    description,
                                    currencyCode,
                                    priceAmount1000,
                                    retailerId,
                                    url,
                                    productImageCount: 1
                                },
                                businessOwnerJid: "0@s.whatsapp.net"
                            }
                        },
                        nativeFlowMessage: { buttons }
                    }
                }
            }
        }
    }

    async handleAlbum(content, jid, quoted) {
        const array = content.albumMessage
        const album = await this.utils.generateWAMessageFromContent(jid, {
            messageContextInfo: {
                messageSecret: crypto.randomBytes(32),
            },
            albumMessage: {
                expectedImageCount: array.filter((a) => a.hasOwnProperty("image")).length,
                expectedVideoCount: array.filter((a) => a.hasOwnProperty("video")).length,
            },
        }, {
            userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
            quoted,
            upload: this.waUploadToServer
        })

        await this.relayMessage(jid, album.message, {
            messageId: album.key.id,
            noSelfSync: true
        })

        for (let content of array) {
            const img = await this.utils.generateWAMessage(jid, content, {
                upload: this.waUploadToServer,
            })

            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key,
                },
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast",
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ["Y", "Important"],
                isHighlighted: true,
                businessMessageForwardInfo: {
                    businessOwnerJid: jid,
                },
                dataSharingContext: {
                    showMmDisclosure: true,
                },
            }

            img.message.forwardedNewsletterMessageInfo = {
                newsletterJid: "0@newsletter",
                serverMessageId: 1,
                newsletterName: `WhatsApp`,
                timestamp: new Date().toISOString(),
                senderName: "Mamzhandsome-XY",
                contentType: "UPDATE_CARD",
                priority: "high",
                status: "sent",
            }

            img.message.disappearingMode = {
                initiator: 3,
                trigger: 4,
                initiatorDeviceJid: jid,
                initiatedByExternalService: true,
                initiatedByUserDevice: true,
                initiatedBySystem: true,
                initiatedByServer: true,
                initiatedByAdmin: true,
                initiatedByUser: true,
                initiatedByApp: true,
                initiatedByBot: true,
                initiatedByMe: true,
            }

            await this.relayMessage(jid, img.message, {
                messageId: img.key.id,
                quoted: {
                    key: {
                        remoteJid: album.key.remoteJid,
                        id: album.key.id,
                        fromMe: true,
                        participant: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                    },
                    message: album.message,
                },
            })
        }
        return album
    }

    async handleEvent(content, jid, quoted) {
        const eventData = content.eventMessage

        const msg = await this.utils.generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2,
                        messageSecret: crypto.randomBytes(32),
                        supportPayload: JSON.stringify({
                            version: 2,
                            is_ai_message: true,
                            should_show_system_message: true,
                            ticket_id: crypto.randomBytes(16).toString('hex')
                        })
                    },
                    eventMessage: {
                        contextInfo: {
                            mentionedJid: [jid],
                            participant: jid,
                            remoteJid: "status@broadcast",
                            forwardedNewsletterMessageInfo: {
                                newsletterName: "Mamzhandsome",
                                newsletterJid: MAMZHANDSOME_CHANNEL_JID,
                                serverMessageId: 1
                            }
                        },
                        isCanceled: eventData.isCanceled || false,
                        name: eventData.name,
                        description: eventData.description,
                        location: eventData.location || {
                            degreesLatitude: 0,
                            degreesLongitude: 0,
                            name: "Location"
                        },
                        joinLink: eventData.joinLink || '',
                        startTime: typeof eventData.startTime === 'string'? parseInt(eventData.startTime) : eventData.startTime || Date.now(),
                        endTime: typeof eventData.endTime === 'string'? parseInt(eventData.endTime) : eventData.endTime || Date.now() + 3600000,
                        extraGuestsAllowed: eventData.extraGuestsAllowed!== false
                    }
                }
            }
        }, { quoted })

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id,
            noSelfSync: true
        })
        return msg
    }

    async handlePollResult(content, jid, quoted) {
        const pollData = content.pollResultMessage
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            pollResultSnapshotMessage: {
                name: pollData.name,
                pollVotes: pollData.pollVotes.map(vote => ({
                    optionName: vote.optionName,
                    optionVoteCount: typeof vote.optionVoteCount === 'number'
                       ? vote.optionVoteCount.toString()
                        : vote.optionVoteCount
                })),
                contextInfo: {
                    isForwarded: true,
                    forwardingScore: 1,
                    forwardedNewsletterMessageInfo: {
                        newsletterName: pollData.newsletter.newsletterName || "Newsletter",
                        newsletterJid: pollData.newsletter.newsletterJid || MAMZHANDSOME_CHANNEL_JID,
                        serverMessageId: 1000,
                        contentType: "UPDATE"
                    }
                }
            }
        }, {
            userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
            quoted
        })

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id,
            noSelfSync: true
        })

        return msg
    }

    async handleOrderMessage(content, jid, quoted) {
        const orderData = content.orderMessage

        const Haha = await this.utils.generateWAMessageFromContent(jid, {
            orderMessage: {
                orderId: orderData.orderId || ("MAMZHANDSOME" + Date.now()),
                thumbnail: orderData.thumbnail || null,
                itemCount: orderData.itemCount || 0,
                status: "ACCEPTED",
                surface: "CATALOG",
                message: orderData.message,
                orderTitle: orderData.orderTitle,
                sellerJid: "0@whatsapp.net",
                token: orderData.token || "MAMZHANDSOME_EXAMPLE_TOKEN",
                totalAmount1000: orderData.totalAmount1000 || 0,
                totalCurrencyCode: orderData.totalCurrencyCode || "IDR",
                messageVersion: 2
            }
        }, { quoted: quoted })

        await this.relayMessage(jid, Haha.message, {})
        return Haha
    }

    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatus
        let messageContent

        if (storyData.message) {
            messageContent = storyData
        } else {
            if (typeof this.utils?.generateWAMessageContent === "function") {
                messageContent = await this.utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                })
            } else {
                messageContent = await Utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                })
            }
        }

        let msg = {
            message: {
                groupStatusMessageV2: {
                    message: messageContent.message || messageContent
                }
            }
        }

        return await this.relayMessage(jid, msg.message, {
            messageId: this.utils.generateMessageID(),
            noSelfSync: true
        })
    }

    async handleGbLabel(content, jid) {
        const x = content.groupLabel
        if (!jid.endsWith('@g.us')) {
            throw new Error('group required!')
        }

        const msg = await this.utils.generateWAMessageFromContent(jid, {
            protocolMessage: {
                type: "GROUP_MEMBER_LABEL_CHANGE",
                memberLabel: {
                    label: x.labelText.slice(0, 30)
                }
            }
        }, {})

        await this.relayMessage(jid, msg.message, {
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        tag_reason: 'user_update',
                        appdata: 'member_tag'
                    },
                    content: undefined
                }
            ]
        })
    }

    /**
     * Post a WhatsApp Status (story) and notify specific people that they were
     * mentioned in it — including expanding a group JID into its members.
     * Requires `context` to have been passed to the constructor (authState,
     * groupMetadata, logger, and the usual link-preview/media config).
     *
     * @param content Same shape as sendMessage's content (text/image/video/audio/etc).
     * @param jids JIDs (user or group) to notify as "mentioned in this status".
     */
    async sendStatusWhatsApp(content, jids = []) {
        const { authState, groupMetadata, logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, mediaCache, options } = this.context
        if (!authState) {
            throw new Error('sendStatusWhatsApp requires this.context.authState — pass it to the imup constructor.')
        }
        const userJid = jidNormalizedUser(authState.creds.me.id)
        const allUsers = new Set()
        allUsers.add(userJid)
        for (const id of jids) {
            if (isJidGroup(id)) {
                try {
                    const metadata = groupMetadata ? await groupMetadata(id) : null
                    metadata?.participants?.forEach(p => allUsers.add(jidNormalizedUser(p.id)))
                }
                catch (error) {
                    logger?.error?.({ error, id }, 'sendStatusWhatsApp: failed to get group metadata')
                }
            }
            else if (isPnUser(id)) {
                allUsers.add(jidNormalizedUser(id))
            }
        }
        const uniqueUsers = Array.from(allUsers)
        const getRandomHexColor = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
        const isMedia = !!(content.image || content.video || content.audio)
        const isAudio = !!content.audio
        const messageContent = { ...content }
        if (isMedia && !isAudio) {
            if (messageContent.text) {
                messageContent.caption = messageContent.text
                delete messageContent.text
            }
            delete messageContent.ptt
            delete messageContent.font
            delete messageContent.backgroundColor
            delete messageContent.textColor
        }
        if (isAudio) {
            delete messageContent.text
            delete messageContent.caption
            delete messageContent.font
            delete messageContent.textColor
        }
        const font = !isMedia ? (content.font ?? Math.floor(Math.random() * 9)) : undefined
        const textColor = !isMedia ? (content.textColor || getRandomHexColor()) : undefined
        const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHexColor()) : undefined
        const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

        const msg = await this.utils.generateWAMessage(STORIES_JID, messageContent, {
            logger,
            userJid,
            getUrlInfo: text => this.utils.getUrlInfo(text, {
                thumbnailWidth: linkPreviewImageThumbnailWidth,
                fetchOpts: { timeout: 3000, ...(options || {}) },
                logger,
                uploadImage: generateHighQualityLinkPreview ? this.waUploadToServer : undefined
            }),
            upload: this.waUploadToServer,
            mediaCache,
            options,
            font,
            textColor,
            backgroundColor,
            ptt
        })

        await this.relayMessage(STORIES_JID, msg.message, {
            messageId: msg.key.id,
            statusJidList: uniqueUsers,
            additionalNodes: [{
                tag: 'meta',
                attrs: {},
                content: [{
                    tag: 'mentioned_users',
                    attrs: {},
                    content: jids.map(jid => ({ tag: 'to', attrs: { jid: jidNormalizedUser(jid) } }))
                }]
            }]
        })

        for (const id of jids) {
            try {
                const normalizedId = jidNormalizedUser(id)
                const isPrivate = isPnUser(normalizedId)
                const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'
                const protocolMessage = {
                    [type]: {
                        message: { protocolMessage: { key: msg.key, type: 25 } }
                    },
                    messageContextInfo: { messageSecret: crypto.randomBytes(32) }
                }
                const statusMsg = await this.utils.generateWAMessageFromContent(normalizedId, protocolMessage, { userJid })
                await this.relayMessage(normalizedId, statusMsg.message, {
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: isPrivate ? { is_status_mention: 'true' } : { is_group_status_mention: 'true' }
                    }]
                })
                await this.utils.delay(2000)
            }
            catch (error) {
                logger?.error?.({ error, id }, 'sendStatusWhatsApp: failed to notify recipient')
            }
        }
        return msg
    }
}
