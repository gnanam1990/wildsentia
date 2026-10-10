import { describe, expect, it } from 'vitest';
import { animalFromHash, followedHash } from '../src/animalLink.js';

describe('the address bar names the followed animal', () => {
  it('sets, replaces and removes the animal while keeping other fragment values', () => {
    expect(followedHash('', 'tiger_01')).toBe('#animal=tiger_01');
    expect(followedHash('#animal=tiger_01', 'sambar_7')).toBe('#animal=sambar_7');
    expect(animalFromHash(followedHash('#animal=tiger_01', 'sambar_7'))).toBe('sambar_7');
    expect(followedHash('#view=wide&animal=tiger_01', 'hare_2')).toBe('#view=wide&animal=hare_2');
    expect(followedHash('#animal=tiger_01', null)).toBe('');
    expect(followedHash('#view=wide&animal=tiger_01', null)).toBe('#view=wide');
    expect(followedHash('', null)).toBe('');
  });
  it('never writes an identity a shared link would refuse', () => {
    expect(followedHash('#animal=tiger_01', 'bad id<script>')).toBe('');
    expect(followedHash('#animal=a&animal=b', 'tiger_01')).toBe('#animal=tiger_01');
  });
});
