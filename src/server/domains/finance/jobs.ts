import { registerPeriodic } from '../../jobs/registry';
import { runOpenBillsSweep } from './open-bills';

/** Visits whose bill was left open (not completed, or completed with a balance due) alert the desk once. */
registerPeriodic({ name: 'finance.open-bills', everySec: 900, run: async () => { await runOpenBillsSweep(); } });
