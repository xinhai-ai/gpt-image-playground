import { describe, expect, it } from 'vitest'
import { saasProviderProfileToApiProfile, type SaasProviderProfile } from './saasApi'

describe('saasProviderProfileToApiProfile', () => {
  it('preserves the backend configured API mode', () => {
    const profile: SaasProviderProfile = {
      id: 'profile-responses',
      name: 'Responses Channel',
      provider: 'openai',
      model: 'gpt-4.1',
      apiMode: 'responses',
    }

    expect(saasProviderProfileToApiProfile(profile)).toMatchObject({
      id: 'profile-responses',
      provider: 'openai',
      model: 'gpt-4.1',
      apiMode: 'responses',
    })
  })
})
