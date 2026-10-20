import {describe, expect, it, vi} from 'vitest';
import {validateToolInput} from '@momoki/agent-core';

describe('shared tool argument dispatch', () => {
    it('checks uniqueness, offered authority and raw size before parsing', () => {
        const tool = {name: 'write', parseArguments: vi.fn((value: unknown) => value)};
        const errors = {
            unavailable: () => new Error('unavailable'),
            tooLarge: () => new Error('too large'),
            invalid: () => new Error('invalid'),
        };
        expect(() => validateToolInput('write', '{}', ['write'], [tool, tool], errors)).toThrow('工具名称重复');
        expect(() => validateToolInput('write', '{}', [], [tool], errors)).toThrow('unavailable');
        expect(() => validateToolInput('absent', '{}', ['absent'], [tool], errors)).toThrow('unavailable');
        expect(() => validateToolInput('write', ' '.repeat(32_769), ['write'], [tool], errors)).toThrow('too large');
        expect(tool.parseArguments).not.toHaveBeenCalled();
        expect(validateToolInput('write', '0'.padStart(32_768), ['write'], [tool], errors).args).toBe(0);
    });

    it('passes the original cause and parsed input to the host diagnostic hook', () => {
        const cause = new Error('schema detail'), safe = new Error('safe diagnostic');
        const tool = {name: 'write', parseArguments: (_value: unknown): unknown => {throw cause;}};
        const invalid = vi.fn(() => safe);
        const errors = {unavailable: () => safe, tooLarge: () => safe, invalid};
        expect(() => validateToolInput('write', '{', ['write'], [tool], errors)).toThrow(safe);
        expect(invalid).toHaveBeenLastCalledWith(tool, undefined, expect.any(SyntaxError));
        expect(() => validateToolInput('write', '{"value":2}', ['write'], [tool], errors)).toThrow(safe);
        expect(invalid).toHaveBeenLastCalledWith(tool, {value: 2}, cause);
    });
});
