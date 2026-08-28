#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const booster = readFileSync(resolve(import.meta.dir, '..', 'orange5-priority-booster.ps1'), 'utf8');

describe('retired Navigator residency observer', () => {
  test('can report residency but cannot load or pin model weights', () => {
    expect(booster).toContain("$navigatorModel = 'orange-navigator:ornith-1.5-9b-q4km'");
    expect(booster).toContain("residency_policy='lease_on_demand'");
    expect(booster).toContain('/api/ps');
    expect(booster).not.toContain('/api/generate');
    expect(booster).not.toContain('keep_alive');
    expect(booster).not.toContain('repin');
  });
});
