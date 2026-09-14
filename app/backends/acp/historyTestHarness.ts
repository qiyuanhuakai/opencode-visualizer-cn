import { createAcpSessionState } from './history';

export const WIRE_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'step-plan/step-3.5-flash',
    options: [
      { value: 'step-plan/step-3.5-flash', name: 'step-3.5-flash' },
      { value: 'lm-studio/qwen3.6-28b', name: 'qwen3.6-28b' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'build',
    options: [
      { value: 'normal', name: 'Normal' },
      { value: 'build', name: 'Build' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'off',
    options: [{ value: 'off', name: 'Off' }],
  },
];

export function createState(configOptions: unknown[] = []) {
  return createAcpSessionState({ id: 'session-1', title: 'session-1' }, configOptions);
}
