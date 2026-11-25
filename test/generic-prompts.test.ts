import test from 'node:test';
import assert from 'node:assert/strict';
import { scenePrompt, reviewPrompt } from '../src/engine/prompts.ts';

const baseCtx = {
  skeleton: '',
  arc: '',
  cast: '',
  related: '',
  bible: '',
  recap: '',
  tail: '',
  threads: '',
  facts: '',
  style: '',
  plan: '',
  styleSample: '',
  template: '',
  chars: 0,
};

function ctxFor(mark: string) {
  return {
    ...baseCtx,
    skeleton: `书名：TITLE_${mark}`,
    cast: `CAST_${mark}`,
    bible: `BIBLE_${mark}`,
    facts: `FACTS_${mark}`,
    style: `VOICE_${mark}`,
    styleSample: `SAMPLE_${mark}`,
  };
}

function sceneFor(mark: string) {
  return scenePrompt({
    ctx: ctxFor(mark),
    chapterIdx: 1,
    planTitle: `PLAN_${mark}`,
    planGoal: `GOAL_${mark}`,
    beatIndex: 0,
    beatTotal: 2,
    beat: { place: `PLACE_${mark}`, present: [`CAST_${mark}`], action: `ACTION_${mark}`, shift: `SHIFT_${mark}` },
    writtenSoFar: `PREVIOUS_${mark}`,
    targetWords: 600,
    synopsis: `SYNOPSIS_${mark}`,
    pov: `POV_${mark}`,
  });
}

test('不同书的上下文和声纹只能进入自己的生成提示词', () => {
  const a = sceneFor('ALPHA');
  const b = sceneFor('BETA');
  assert.match(a, /VOICE_ALPHA/);
  assert.match(a, /SAMPLE_ALPHA/);
  assert.doesNotMatch(a, /VOICE_BETA|SAMPLE_BETA|PLAN_BETA|POV_BETA/);
  assert.match(b, /VOICE_BETA/);
  assert.match(b, /SAMPLE_BETA/);
  assert.doesNotMatch(b, /VOICE_ALPHA|SAMPLE_ALPHA|PLAN_ALPHA|POV_ALPHA/);
});

test('审稿提示词同样不能串入另一本书的声纹或设定', () => {
  const a = reviewPrompt({ ctx: ctxFor('ALPHA'), chapterIdx: 1, title: 'TITLE_ALPHA', content: 'CONTENT_ALPHA' });
  const b = reviewPrompt({ ctx: ctxFor('BETA'), chapterIdx: 1, title: 'TITLE_BETA', content: 'CONTENT_BETA' });
  assert.match(a, /VOICE_ALPHA/);
  assert.doesNotMatch(a, /VOICE_BETA|BIBLE_BETA|FACTS_BETA|CONTENT_BETA/);
  assert.match(b, /VOICE_BETA/);
  assert.doesNotMatch(b, /VOICE_ALPHA|BIBLE_ALPHA|FACTS_ALPHA|CONTENT_ALPHA/);
});
