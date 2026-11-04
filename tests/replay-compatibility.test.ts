import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAnyProject, serializeProject, documentFromWorking } from '../src/project-v2.ts';
import { acceptCommand } from '../src/commands.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { currentStructuredQA, replayStructuredQA, CURRENT_VALIDATION_PROFILE } from '../src/structured/validation-profile.ts';
import { METHOD_REGISTRY, methodKey } from '../src/provenance/registry.ts';
import { digestSync } from '../src/provenance/sync-identity.ts';
import { schemaValid } from './schema-check.ts';
import type { ProjectDocument } from '../src/model/document.ts';

const fixtures: { cases: { name: string; document: ProjectDocument }[] } = JSON.parse(await readFile(new URL('./fixtures/validation-profiles-v4.json', import.meta.url), 'utf8'));
const v2Fixtures: typeof fixtures = JSON.parse(await readFile(new URL('./fixtures/validation-profiles-v2-v4.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../public/project-v4.schema.json', import.meta.url), 'utf8'));

test('historical structured profiles replay exact scenes and QA across all adapters', async () => {
  const adapters = new Set<string>();
  for (const entry of [...fixtures.cases, ...v2Fixtures.cases]) {
    const before = structuredClone(entry.document.structuredViews);
    const loaded = await loadAnyProject(JSON.stringify(entry.document));
    for (const view of Object.values(loaded.project.authoring.structuredViews!)) {
      adapters.add(view.adapter);
      assert.equal(view.validationProfile, entry.document.structuredViews![view.id].validationProfile);
      assert.deepEqual(replayStructuredQA(view, loaded.source), view.qa);
    }
    assert.deepEqual(loaded.project.authoring.structuredViews, before);
    assert.equal(schemaValid(documentFromWorking(loaded.project), schema, schema), true, entry.name);
    const serialized = serializeProject(loaded.project);
    const reopened = await loadAnyProject(serialized);
    assert.deepEqual(reopened.project.authoring.structuredViews, before);
    assert.equal(serializeProject(reopened.project), serialized);
  }
  assert.deepEqual([...adapters].sort(), ['clade-cluster-v1', 'classification-rank-v1', 'compound-artistic-v1', 'metric-distance-v1', 'unrooted-angle-v1'].sort());
});

test('historical incorrect passes reopen intact while current checks catch both failures', async () => {
  for (const entry of fixtures.cases.filter(entry => entry.name.endsWith('-pass'))) {
    const loaded = await loadAnyProject(JSON.stringify(entry.document));
    const view = Object.values(loaded.project.authoring.structuredViews!)[0];
    const before = digestSync(view);
    assert.equal(view.qa.status, 'checked');
    const current = currentStructuredQA(view, loaded.source);
    assert.equal(current.status, 'draft', entry.name);
    assert.equal(current.crossingPassed, false, entry.name);
    assert.equal(digestSync(view), before, 'A current check must not rewrite historical evidence.');
    const files = exportStructuredFiles(loaded.source, loaded.project);
    const report = JSON.parse(files['qa_report.json']);
    assert.equal(report.validationProfile, CURRENT_VALIDATION_PROFILE);
    assert.equal(report.storedValidationProfile, 'compound-v1');
    assert.equal(report.status, 'draft');
    assert.equal(report.validationMethodDefinition.version, '3.0.0');
    assert.equal(JSON.parse(files['tree.treeproject.json']).structuredViews[view.id].qa.status, 'checked');
    assert.match(files['tree_labeled.svg'], /&quot;qaStatus&quot;:&quot;draft&quot;/);
  }
});

test('accepting a current recheck preserves geometry and has idempotent save/reopen', async () => {
  const loaded = await loadAnyProject(JSON.stringify(fixtures.cases[0].document));
  const proposal = structuredClone(loaded.project);
  const before = Object.fromEntries(Object.values(proposal.authoring.structuredViews!).map(view => [view.id, digestSync(view.scene)]));
  for (const view of Object.values(proposal.authoring.structuredViews!)) {
    view.validationProfile = CURRENT_VALIDATION_PROFILE;
    view.qa = currentStructuredQA(view, loaded.source);
  }
  const accepted = acceptCommand(loaded.project, proposal, loaded.source, { methods: ['compound-validation'], notes: 'Explicit current QA recheck; stored artwork unchanged.' });
  for (const view of Object.values(accepted.authoring.structuredViews!)) assert.equal(digestSync(view.scene), before[view.id]);
  assert.equal(schemaValid(documentFromWorking(accepted), schema, schema), true);
  const serialized = serializeProject(accepted);
  const reopened = await loadAnyProject(serialized);
  assert.equal(serializeProject(reopened.project), serialized);
  assert.deepEqual(reopened.project.authoring.structuredViews, accepted.authoring.structuredViews);
  assert.ok(accepted.authoring.provenance.methods['compound-validation@3.0.0']);
});

test('unknown or mismatched QA profiles and forged saved geometry remain rejected', async () => {
  const original = fixtures.cases[0].document;
  const id = Object.keys(original.structuredViews!)[0];
  const unknown = structuredClone(original) as any;
  unknown.structuredViews[id].validationProfile = 'compound-v999';
  await assert.rejects(loadAnyProject(JSON.stringify(unknown)), /validation profile/);
  assert.equal(schemaValid(unknown, schema, schema), false);
  const mismatch = structuredClone(original);
  mismatch.structuredViews![id].validationProfile = CURRENT_VALIDATION_PROFILE;
  await assert.rejects(loadAnyProject(JSON.stringify(mismatch)), /QA do not replay/);
  assert.equal(schemaValid(mismatch, schema, schema), false);
  const forged = structuredClone(original);
  forged.structuredViews![id].scene.junctionGlyphs[0].anchor.x += 1;
  await assert.rejects(loadAnyProject(JSON.stringify(forged)), /do not replay/);
  const fakeQA = structuredClone(original);
  fakeQA.structuredViews![id].qa.checkedPairs += 1;
  await assert.rejects(loadAnyProject(JSON.stringify(fakeQA)), /QA do not replay/);
});

test('new operations select current methods without modifying historical definitions', () => {
  for (const id of ['compound-validation', 'metric-distance-validation', 'classification-validation', 'unrooted-validation', 'route-search', 'readability-assist']) {
    assert.equal(methodKey(id), `${id}@3.0.0`);
    assert.equal(methodKey(`${id}@1.0.0`), `${id}@1.0.0`);
    assert.equal(methodKey(`${id}@2.0.0`), `${id}@2.0.0`);
    assert.equal(METHOD_REGISTRY[`${id}@1.0.0`].version, '1.0.0');
    assert.notEqual(METHOD_REGISTRY[`${id}@1.0.0`].specificationSha256, METHOD_REGISTRY[`${id}@2.0.0`].specificationSha256);
    assert.notEqual(METHOD_REGISTRY[`${id}@2.0.0`].specificationSha256, METHOD_REGISTRY[`${id}@3.0.0`].specificationSha256);
  }
});

test('v2 stored checks remain exact while current rechecks and exports use incidence-aware v3', async () => {
  for (const entry of v2Fixtures.cases) {
    const loaded = await loadAnyProject(JSON.stringify(entry.document)), proposal = structuredClone(loaded.project);
    for (const view of Object.values(proposal.authoring.structuredViews!)) {
      assert.equal(view.validationProfile, 'compound-v2');
      assert.equal(view.qa.completeness!.incidence, undefined);
      const sceneBefore = digestSync(view.scene);
      view.qa = currentStructuredQA(view, loaded.source);
      view.validationProfile = CURRENT_VALIDATION_PROFILE;
      assert.equal(view.qa.completeness!.incidence, true);
      assert.equal(digestSync(view.scene), sceneBefore);
    }
    const saved = acceptCommand(loaded.project, proposal, loaded.source, { methods: ['compound-validation'], notes: 'Accepted v3 incidence-aware recheck.' });
    const serialized = serializeProject(saved), reopened = await loadAnyProject(serialized);
    assert.equal(serializeProject(reopened.project), serialized);
    assert.equal(schemaValid(documentFromWorking(saved), schema, schema), true);
    const report = JSON.parse(exportStructuredFiles(loaded.source, loaded.project)['qa_report.json']);
    assert.equal(report.storedValidationProfile, 'compound-v2');
    assert.equal(report.validationProfile, CURRENT_VALIDATION_PROFILE);
    assert.equal(report.completeness.incidence, true);
    const forged = documentFromWorking(saved), view = Object.values(forged.structuredViews!)[0];
    view.validationProfile = 'compound-v2';
    assert.equal(schemaValid(forged, schema, schema), false, 'v3 QA cannot masquerade as v2 evidence');
    await assert.rejects(loadAnyProject(JSON.stringify(forged)), /QA do not replay/);
  }
});
