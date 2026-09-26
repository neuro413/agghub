import type { ChannelType } from '../types'
import type { Adaptor } from './base'
import { openaiAdaptor } from './openai'
import { anthropicAdaptor } from './anthropic'
import { vertexAdaptor } from './vertex'
import { responsesAdaptor } from './responses'

export function getAdaptor(type: ChannelType): Adaptor {
  switch (type) {
    case 'openai':
      return openaiAdaptor
    case 'anthropic':
      return anthropicAdaptor
    case 'vertex':
      return vertexAdaptor
    case 'responses':
      return responsesAdaptor
  }
}

export type { Adaptor, UpstreamRequest } from './base'
