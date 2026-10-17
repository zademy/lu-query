import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';

describe('protocolo MCP sobre stdio simulado', () => {
  it('responde initialize con la versión declarada', async () => {
    const { client, close } = await createHarness();

    try {
      expect(client.getServerVersion()).toEqual({ name: 'lu-query', version: '2.13.0' });
    } finally {
      await close();
    }
  });

  it('responde tools/list con las tools registradas', async () => {
    const { client, close } = await createHarness();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('test_connection');
    } finally {
      await close();
    }
  });

  it('expone el recurso de auditoría aunque no haya sesiones', async () => {
    const { client, close } = await createHarness();

    try {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual(['oracle://audit/sessions']);
    } finally {
      await close();
    }
  });
});

describe('createServer', () => {
  it('arranca sin conectar a Oracle cuando se le inyecta un backend fake', async () => {
    const { server, dataAccess, close } = await createHarness();

    try {
      expect(server).toBeInstanceOf(McpServer);
      expect(dataAccess.closed).toBe(false);
    } finally {
      await close();
    }
  });

  it('cierra el backend al apagar el server', async () => {
    const { dataAccess, close } = await createHarness();

    await close();

    expect(dataAccess.closed).toBe(true);
  });
});
