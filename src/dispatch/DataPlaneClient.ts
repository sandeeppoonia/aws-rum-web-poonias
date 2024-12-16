import { toHex } from '@aws-sdk/util-hex-encoding';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import {
    AwsCredentialIdentityProvider,
    AwsCredentialIdentity,
    HttpResponse,
    RequestPresigningArguments
} from '@aws-sdk/types';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpHandler, HttpRequest } from '@aws-sdk/protocol-http';
import {
    AppMonitorDetails,
    PutRumEventsRequest,
    UserDetails,
    RumEvent
} from './dataplane';

const SERVICE = 'rum';
const METHOD = 'POST';
const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_TEXT = 'text/plain;charset=UTF-8';

const REQUEST_PRESIGN_ARGS: RequestPresigningArguments = { expiresIn: 60 };

declare type SerializedRumEvent = {
    id: string;
    timestamp: number; // unix timestamp in seconds
    type: string;
    metadata?: string;
    details: string;
};

declare type SerializedPutRumEventsRequest = {
    BatchId: string;
    AppMonitorDetails: AppMonitorDetails;
    UserDetails: UserDetails;
    RumEvents: SerializedRumEvent[];
};

export declare type DataPlaneClientConfig = {
    fetchRequestHandler: HttpHandler;
    beaconRequestHandler: HttpHandler;
    endpoint: URL;
    region: string;
    credentials:
        | AwsCredentialIdentityProvider
        | AwsCredentialIdentity
        | undefined;
};

export class DataPlaneClient {
    private config: DataPlaneClientConfig;
    private awsSigV4: SignatureV4 | undefined;

    constructor(config: DataPlaneClientConfig) {
        this.config = config;
        if (config.credentials) {
            this.awsSigV4 = new SignatureV4({
                applyChecksum: true,
                credentials: config.credentials,
                region: config.region,
                service: SERVICE,
                uriEscapePath: true,
                sha256: Sha256
            });
        }
    }

    public sendFetch = async (
        putRumEventsRequest: PutRumEventsRequest
    ): Promise<{ response: HttpResponse }> => {
        const options = await this.getHttpRequestOptions(
            putRumEventsRequest,
            CONTENT_TYPE_JSON
        );
        let request: HttpRequest = new HttpRequest(options);
        if (this.awsSigV4) {
            request = (await this.awsSigV4.sign(request)) as HttpRequest;
        }
        const httpResponse: Promise<{
            response: HttpResponse;
        }> = this.config.fetchRequestHandler.handle(request);
        return httpResponse;
    };

    public sendBeacon = async (
        putRumEventsRequest: PutRumEventsRequest
    ): Promise<{ response: HttpResponse }> => {
        const options = await this.getHttpRequestOptions(
            putRumEventsRequest,
            CONTENT_TYPE_TEXT
        );
        let request: HttpRequest = new HttpRequest(options);
        if (this.awsSigV4) {
            request = (await this.awsSigV4.presign(
                request,
                REQUEST_PRESIGN_ARGS
            )) as HttpRequest;
        }
        const httpResponse: Promise<{
            response: HttpResponse;
        }> = this.config.beaconRequestHandler.handle(request);
        return httpResponse;
    };

    private getHttpRequestOptions = async (
        putRumEventsRequest: PutRumEventsRequest,
        contentType: string
    ) => {
        const serializedRequest: string = JSON.stringify(
            serializeRequest(putRumEventsRequest)
        );
        const path = this.config.endpoint.pathname.replace(/\/$/, '');
        const options = {
            method: METHOD,
            protocol: this.config.endpoint.protocol,
            port: this.config.endpoint.port,
            headers: {
                'content-type': contentType,
                host: this.config.endpoint.host
            },
            hostname: this.config.endpoint.hostname,
            path: `${path}/appmonitors/${putRumEventsRequest.AppMonitorDetails.id}`,
            body: serializedRequest
        };
        if (this.awsSigV4) {
            return {
                ...options,
                headers: {
                    ...options.headers,
                    'X-Amz-Content-Sha256': await hashAndEncode(
                        serializedRequest
                    )
                }
            };
        }
        return options;
    };
}

const serializeRequest = (
    request: PutRumEventsRequest
): SerializedPutRumEventsRequest => {
    //  If we were using the AWS SDK client here then the serialization would be handled for us through a generated
    //  serialization/deserialization library. However, since much of the generated code is unnecessary, we do the
    //  serialization ourselves with this function.
    const serializedRumEvents: SerializedRumEvent[] = [];
    request.RumEvents.forEach((e) =>
        serializedRumEvents.push(serializeEvent(e))
    );
    const serializedRequest: SerializedPutRumEventsRequest = {
        BatchId: request.BatchId,
        AppMonitorDetails: request.AppMonitorDetails,
        UserDetails: request.UserDetails,
        RumEvents: serializedRumEvents
    };
    return serializedRequest;
};

const serializeEvent = (event: RumEvent): SerializedRumEvent => {
    return {
        id: event.id,
        // Dates must be converted to timestamps before serialization.
        timestamp: Math.round(event.timestamp.getTime() / 1000),
        type: event.type,
        metadata: event.metadata,
        details: event.details
    };
};

const hashAndEncode = async (payload: string) => {
    const sha256 = new Sha256();
    sha256.update(payload);
    return toHex(await sha256.digest()).toLowerCase();
};
