import pTimeout from 'p-timeout'
import { v4 as uuidv4 } from 'uuid'

import * as types from './types'
import { fetch as globalFetch } from './fetch'
import { fetchSSE } from './fetch-sse'
import { isValidUUIDv4 } from './utils'

export class ChatGPTUnofficialProxyAPI {
  protected _accessToken: string
  protected _apiReverseProxyUrl: string
  protected _debug: boolean
  protected _model: string
  protected _headers: Record<string, string>
  protected _fetch: types.FetchFn

  /**
   * @param fetch - Optional override for the `fetch` implementation to use. Defaults to the global `fetch` function.
   */
  constructor(opts: {
    accessToken: string

    /** @defaultValue `https://bypass.duti.tech/api/conversation` **/
    apiReverseProxyUrl?: string

    /** @defaultValue `text-davinci-002-render-sha` **/
    model?: string

    /** @defaultValue `false` **/
    debug?: boolean

    /** @defaultValue `undefined` **/
    headers?: Record<string, string>

    fetch?: types.FetchFn
  }) {
    const {
      accessToken,
      apiReverseProxyUrl = 'https://bypass.duti.tech/api/conversation',
      model = 'text-davinci-002-render-sha',
      debug = false,
      headers,
      fetch = globalFetch
    } = opts

    this._accessToken = accessToken
    this._apiReverseProxyUrl = apiReverseProxyUrl
    this._debug = !!debug
    this._model = model
    this._fetch = fetch
    this._headers = headers

    if (!this._accessToken) {
      throw new Error('ChatGPT invalid accessToken')
    }

    if (!this._fetch) {
      throw new Error('Invalid environment; fetch is not defined')
    }

    if (typeof this._fetch !== 'function') {
      throw new Error('Invalid "fetch" is not a function')
    }
  }

  get accessToken(): string {
    return this._accessToken
  }

  set accessToken(value: string) {
    this._accessToken = value
  }

  /**
   * Sends a message to ChatGPT, waits for the response to resolve, and returns
   * the response.
   *
   * If you want your response to have historical context, you must provide a valid `parentMessageId`.
   *
   * If you want to receive a stream of partial responses, use `opts.onProgress`.
   * If you want to receive the full response, including message and conversation IDs,
   * you can use `opts.onConversationResponse` or use the `ChatGPTAPI.getConversation`
   * helper.
   *
   * Set `debug: true` in the `ChatGPTAPI` constructor to log more info on the full prompt sent to the OpenAI completions API. You can override the `promptPrefix` and `promptSuffix` in `opts` to customize the prompt.
   *
   * @param message - The prompt message to send
   * @param opts.conversationId - Optional ID of a conversation to continue (defaults to a random UUID)
   * @param opts.parentMessageId - Optional ID of the previous message in the conversation (defaults to `undefined`)
   * @param opts.messageId - Optional ID of the message to send (defaults to a random UUID)
   * @param opts.timeoutMs - Optional timeout in milliseconds (defaults to no timeout)
   * @param opts.onProgress - Optional callback which will be invoked every time the partial response is updated
   * @param opts.abortSignal - Optional callback used to abort the underlying `fetch` call using an [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
   *
   * @returns The response from ChatGPT
   */
  async sendMessage(
    text: string,
    opts: types.SendMessageBrowserOptions = {}
  ): Promise<types.ChatMessage> {
    if (!!opts.conversationId !== !!opts.parentMessageId) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: conversationId and parentMessageId must both be set or both be undefined'
      )
    }

    if (opts.conversationId && !isValidUUIDv4(opts.conversationId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: conversationId is not a valid v4 UUID'
      )
    }

    if (opts.parentMessageId && !isValidUUIDv4(opts.parentMessageId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: parentMessageId is not a valid v4 UUID'
      )
    }

    if (opts.messageId && !isValidUUIDv4(opts.messageId)) {
      throw new Error(
        'ChatGPTUnofficialProxyAPI.sendMessage: messageId is not a valid v4 UUID'
      )
    }

    const {
      conversationId,
      parentMessageId = uuidv4(),
      messageId = uuidv4(),
      action = 'next',
      timeoutMs,
      onProgress,
      progressTimeoutMs
    } = opts

    let { abortSignal } = opts

    let abortController: AbortController = null
    if (timeoutMs && !abortSignal) {
      abortController = new AbortController()
      abortSignal = abortController.signal
    }

    const body: types.ConversationJSONBody = {
      action,
      messages: [
        {
          id: messageId,
          role: 'user',
          content: {
            content_type: 'text',
            parts: [text]
          }
        }
      ],
      model: this._model,
      parent_message_id: parentMessageId
    }

    if (conversationId) {
      body.conversation_id = conversationId
    }

    const result: types.ChatMessage = {
      role: 'assistant',
      id: uuidv4(),
      parentMessageId: messageId,
      conversationId,
      text: ''
    }

    const responseP = new Promise<types.ChatMessage>((resolve, reject) => {
      const url = this._apiReverseProxyUrl
      const headers = {
        ...this._headers,
        Authorization: `Bearer ${this._accessToken}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      }

      if (this._debug) {
        console.log('POST', url, { body, headers })
      }

      const onProgressPromise = new Promise<void>((res) => {
        fetchSSE(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: abortSignal,
            onMessage: (data: string) => {
              if (data === '[DONE]') {
                return resolve(result)
              }

              try {
                const convoResponseEvent: types.ConversationResponseEvent =
                  JSON.parse(data)
                if (convoResponseEvent.conversation_id) {
                  result.conversationId = convoResponseEvent.conversation_id
                }

                if (convoResponseEvent.message?.id) {
                  result.id = convoResponseEvent.message.id
                }

                const message = convoResponseEvent.message
                // console.log('event', JSON.stringify(convoResponseEvent, null, 2))

                if (message) {
                  let text = message?.content?.parts?.[0]

                  if (text) {
                    result.text = text
                    res(onProgress?.(result))
                  }
                }
              } catch (err) {
                reject(err)
              }
            },
            onError: (err) => {
              reject(err)
            }
          },
          this._fetch
        ).catch((err) => {
          const errMessageL = err.toString().toLowerCase()

          if (
            result.text &&
            (errMessageL === 'error: typeerror: terminated' ||
              errMessageL === 'typeerror: terminated')
          ) {
            // OpenAI sometimes forcefully terminates the socket from their end before
            // the HTTP request has resolved cleanly. In my testing, these cases tend to
            // happen when OpenAI has already send the last `response`, so we can ignore
            // the `fetch` error in this case.
            return resolve(result)
          } else {
            return reject(err)
          }
        })
      })

      if (progressTimeoutMs) {
        if (abortController) {
          ;(onProgressPromise as any).cancel = () => {
            abortController.abort()
          }
        }

        return pTimeout(onProgressPromise, {
          milliseconds: progressTimeoutMs,
          message: 'Caught onProgress timeout'
        }).catch((e) => reject(e))
      } else {
        return onProgressPromise
      }
    })

    if (timeoutMs) {
      if (abortController) {
        // This will be called when a timeout occurs in order for us to forcibly
        // ensure that the underlying HTTP request is aborted.
        ;(responseP as any).cancel = () => {
          abortController.abort()
        }
      }

      return pTimeout(responseP, {
        milliseconds: timeoutMs,
        message: 'ChatGPT timed out waiting for response'
      })
    } else {
      return responseP
    }
  }
}
