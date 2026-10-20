import {requestOnce as dispatchOnce} from '@momoki/agent-providers/http';
import {runtimeFetchFor} from '../runtime/runtimeFetch';
import type {RuntimeHttpPurpose} from '../product/httpPolicy';
import type {RequestBoundaryOptions as TransportOptions} from '@momoki/agent-providers/http';

export type RequestBoundaryOptions = Omit<TransportOptions, 'fetchImpl'> & {
    fetchImpl?: typeof fetch;
    runtimePurpose?: RuntimeHttpPurpose;
};

/** Product adapter selects the authorized runtime transport for this single dispatch. */
export function requestOnce(url: string, init: Omit<RequestInit, 'signal' | 'credentials' | 'redirect'>, options: RequestBoundaryOptions): Promise<Response> {
    return dispatchOnce(url, init, {...options, fetchImpl: options.fetchImpl ?? runtimeFetchFor(options.runtimePurpose)});
}
