// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRecentTimeZones, rememberTimeZone } from '../src/client/recent-time-zones.ts'

afterEach(() => { localStorage.clear() })

describe('recent time zones', () => {
  it('seeds the device zone and UTC without inferring location from language', () => {
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])
    expect(loadRecentTimeZones('UTC')).toEqual(['UTC'])
  })

  it('promotes exact IANA ids, de-duplicates them, and keeps five', () => {
    let recent: readonly string[] = ['UTC']
    for (const zone of ['Asia/Shanghai', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Africa/Lagos', 'UTC']) {
      recent = rememberTimeZone(recent, zone)
    }
    expect(recent).toEqual(['UTC', 'Africa/Lagos', 'Asia/Tokyo', 'America/New_York', 'Europe/Berlin'])
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(recent)
  })

  it('falls back safely when persisted data is invalid', () => {
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '{')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
  })

  it('falls back when persisted data is not an array or holds no usable zone', () => {
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '42')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '["", 7]')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
  })

  it('seeds and promotes without browser storage', () => {
    // A browser that denies storage (private mode, a locked-down embed) must
    // still offer the first-run seed and keep promoting in memory.
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])
      expect(rememberTimeZone(['Europe/Berlin', 'UTC'], 'Asia/Tokyo'))
        .toEqual(['Asia/Tokyo', 'Europe/Berlin', 'UTC'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
