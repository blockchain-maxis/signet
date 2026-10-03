/**
 * @file @signet/spec
 *
 * Events view: `eventV0` entries (SEP-48) decoded through the SDK's XDR types.
 * Contracts built with older SDKs embed none, and an empty list is a fact about
 * the contract rather than a failure.
 */

import type { xdr } from '@stellar/stellar-sdk';
import { toTypeRef } from './type-ref.ts';
import { xdrText } from './xdr-text.ts';
import type { SpecEvent, SpecEventDataFormat, SpecEventParamLocation } from './types.ts';

const DATA_FORMATS: Readonly<Record<string, SpecEventDataFormat>> = {
  scSpecEventDataFormatSingleValue: 'single_value',
  scSpecEventDataFormatVec: 'vec',
  scSpecEventDataFormatMap: 'map',
};

const LOCATIONS: Readonly<Record<string, SpecEventParamLocation>> = {
  scSpecEventParamLocationData: 'data',
  scSpecEventParamLocationTopicList: 'topic',
};

/** `eventV0` entries as `SpecEvent`s, in declaration order. */
export function buildEvents(entries: readonly xdr.ScSpecEntry[]): SpecEvent[] {
  const out: SpecEvent[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== 'scSpecEntryEventV0') continue;
    const ev = entry.eventV0();
    const dataFormatArm = ev.dataFormat().name;
    const dataFormat = DATA_FORMATS[dataFormatArm];
    if (dataFormat === undefined) {
      throw new TypeError(`Unrecognised event data format: ${dataFormatArm}`);
    }
    out.push({
      name: xdrText(ev.name()),
      doc: xdrText(ev.doc()),
      prefixTopics: ev.prefixTopics().map(xdrText),
      params: ev.params().map((p) => {
        const locationArm = p.location().name;
        const location = LOCATIONS[locationArm];
        if (location === undefined) {
          throw new TypeError(`Unrecognised event param location: ${locationArm}`);
        }
        return { name: xdrText(p.name()), type: toTypeRef(p.type()), location };
      }),
      dataFormat,
    });
  }
  return out;
}
