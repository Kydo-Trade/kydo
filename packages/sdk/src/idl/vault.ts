/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/vault.json`.
 */
export type Vault = {
  "address": "G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1",
  "metadata": {
    "name": "vault",
    "version": "0.2.0",
    "spec": "0.1.0",
    "description": "Kydo vault program: pools, investor shares, NAV, risk guard, profit split"
  },
  "instructions": [
    {
      "name": "activatePool",
      "discriminator": [
        129,
        125,
        90,
        174,
        121,
        169,
        225,
        239
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "docs": [
            "The pool's trader profile. Carries the held entry/instant fee."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "applyAsTrader",
      "discriminator": [
        247,
        120,
        91,
        175,
        203,
        154,
        136,
        97
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "traderUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "instantCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimTraderFees",
      "discriminator": [
        89,
        120,
        220,
        98,
        18,
        151,
        218,
        78
      ],
      "accounts": [
        {
          "name": "trader",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "traderUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closePool",
      "discriminator": [
        140,
        189,
        209,
        23,
        239,
        62,
        239,
        11
      ],
      "accounts": [
        {
          "name": "trader",
          "docs": [
            "The pool's trader, or, once the pool's end date has passed, anyone (keeper included)."
          ],
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "relations": [
            "pool"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "closeTrade",
      "discriminator": [
        161,
        199,
        69,
        82,
        9,
        63,
        203,
        42
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "The trader wallet, or a session key authorised by it (see `session`)."
          ],
          "signer": true
        },
        {
          "name": "trader",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "session",
          "docs": [
            "Optional trade-only session key for `trader` (`set_session_key`). Pass `None` when the wallet signs."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "closeTradeArgs"
            }
          }
        }
      ]
    },
    {
      "name": "collectPlatformFee",
      "discriminator": [
        151,
        88,
        172,
        250,
        117,
        185,
        59,
        209
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "commitTrialRoot",
      "discriminator": [
        108,
        143,
        0,
        68,
        104,
        200,
        137,
        242
      ],
      "accounts": [
        {
          "name": "trader",
          "signer": true
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "day",
          "type": "u16"
        },
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "createPool",
      "discriminator": [
        233,
        146,
        209,
        142,
        207,
        104,
        64,
        188
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              },
              {
                "kind": "account",
                "path": "profile.pools_created",
                "account": "traderProfile"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "traderUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createPoolArgs"
            }
          }
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "investor",
          "docs": [
            "The depositor. Must be the pool's own trader. See the module docs.",
            "Kept named `investor` because the position it mints is an ordinary",
            "`InvestorPosition`: a self-seeding trader holds investor shares in their",
            "own pool and redeems them like anyone else."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "docs": [
            "Constraint lives here rather than on `investor` so it can see both",
            "accounts (Anchor resolves in declaration order)."
          ],
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositCommon",
      "discriminator": [
        119,
        219,
        188,
        163,
        151,
        132,
        198,
        223
      ],
      "accounts": [
        {
          "name": "investor",
          "writable": true,
          "signer": true
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "evaluateRisk",
      "discriminator": [
        17,
        98,
        136,
        119,
        67,
        83,
        168,
        175
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "The pool's USDC vault. The bounty is charged here first, against the",
            "trader's first-loss seed, before the communal reserve is touched."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "callerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "finalizeTrial",
      "discriminator": [
        147,
        60,
        145,
        170,
        60,
        231,
        45,
        160
      ],
      "accounts": [
        {
          "name": "attestor",
          "signer": true
        },
        {
          "name": "trader"
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "metrics",
          "type": {
            "defined": {
              "name": "trialMetrics"
            }
          }
        }
      ]
    },
    {
      "name": "fundNextInQueue",
      "discriminator": [
        121,
        171,
        2,
        85,
        215,
        51,
        154,
        249
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.trader",
                "account": "fundingTicket"
              }
            ]
          }
        },
        {
          "name": "rentTo",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket.trader",
                "account": "fundingTicket"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "ticket.trader",
                "account": "fundingTicket"
              },
              {
                "kind": "account",
                "path": "profile.pools_created",
                "account": "traderProfile"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "stake",
          "docs": [
            "CommonPool's stake in the new pool. A normal InvestorPosition owned by the CommonPool PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "commonPool"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "callerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initCommonPool",
      "discriminator": [
        108,
        212,
        4,
        195,
        98,
        56,
        184,
        10
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "commonPoolParams"
            }
          }
        }
      ]
    },
    {
      "name": "initMockOracle",
      "discriminator": [
        50,
        28,
        114,
        119,
        255,
        98,
        24,
        76
      ],
      "accounts": [
        {
          "name": "priceAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketId",
          "type": "u16"
        }
      ]
    },
    {
      "name": "initPlatform",
      "discriminator": [
        29,
        22,
        210,
        225,
        219,
        114,
        193,
        169
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initPlatformArgs"
            }
          }
        }
      ]
    },
    {
      "name": "lockPool",
      "discriminator": [
        154,
        202,
        217,
        175,
        178,
        161,
        30,
        152
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "The pool's USDC vault. The bounty is charged here first, against the",
            "trader's first-loss seed, before the communal reserve is touched."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "callerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "migrateAccount",
      "discriminator": [
        177,
        228,
        60,
        125,
        13,
        116,
        44,
        84
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "target",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "placeTrade",
      "discriminator": [
        102,
        39,
        166,
        38,
        98,
        171,
        190,
        242
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "The trader wallet, or a session key authorised by it (see `session`)."
          ],
          "signer": true
        },
        {
          "name": "trader",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "session",
          "docs": [
            "Optional trade-only session key for `trader` (`set_session_key`). Pass `None` when the wallet signs."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "placeTradeArgs"
            }
          }
        }
      ]
    },
    {
      "name": "promoteTier",
      "discriminator": [
        230,
        202,
        4,
        103,
        126,
        37,
        228,
        158
      ],
      "accounts": [
        {
          "name": "trader",
          "docs": [
            "The pool's trader. Promotion is NOT permissionless: it spends the",
            "trader's own vested escrow, and `escrow_to_first_loss` moves it into",
            "`first_loss_seed`, which no instruction pays back out. Without this",
            "signer anyone could front-run `claim_trader_fees` and convert a",
            "trader's whole claimable balance into cushion they can never withdraw."
          ],
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "queueForFunding",
      "discriminator": [
        175,
        99,
        211,
        110,
        125,
        208,
        89,
        129
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless: anyone may queue an Eligible trader (and pays the ticket rent)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "trader"
        },
        {
          "name": "profile",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "PDA per trader: a second queue attempt fails outright on init."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "reapPool",
      "discriminator": [
        160,
        141,
        27,
        8,
        80,
        83,
        102,
        114
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "commonPool",
          "docs": [
            "Where the remainder goes: back to the investors who funded the pool."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "redeemCommon",
      "discriminator": [
        171,
        120,
        60,
        197,
        140,
        117,
        167,
        251
      ],
      "accounts": [
        {
          "name": "investor",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u128"
        }
      ]
    },
    {
      "name": "registerMarket",
      "discriminator": [
        24,
        163,
        183,
        185,
        145,
        243,
        36,
        146
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "registerMarketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "removeMarket",
      "discriminator": [
        138,
        35,
        250,
        163,
        200,
        202,
        40,
        110
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "marketId",
          "type": "u16"
        }
      ]
    },
    {
      "name": "requestCommonPull",
      "discriminator": [
        196,
        60,
        26,
        86,
        75,
        244,
        22,
        141
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Normally the keeper."
          ],
          "signer": true
        },
        {
          "name": "commonPool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "stake",
          "docs": [
            "The CommonPool's stake in this pool."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "commonPool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "requestRedemption",
      "discriminator": [
        14,
        62,
        182,
        237,
        59,
        79,
        149,
        22
      ],
      "accounts": [
        {
          "name": "investor",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u128"
        }
      ]
    },
    {
      "name": "revokeSessionKey",
      "discriminator": [
        81,
        192,
        32,
        110,
        104,
        116,
        144,
        151
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true,
          "relations": [
            "session"
          ]
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setMarketEnabled",
      "discriminator": [
        206,
        60,
        159,
        159,
        62,
        242,
        4,
        82
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "marketId",
          "type": "u16"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setMockPrice",
      "discriminator": [
        161,
        22,
        71,
        90,
        159,
        254,
        26,
        48
      ],
      "accounts": [
        {
          "name": "priceAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  111,
                  99,
                  107,
                  95,
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "oracle.market_id",
                "account": "mockOracle"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "i64"
        },
        {
          "name": "conf",
          "type": "u64"
        },
        {
          "name": "expo",
          "type": "i32"
        }
      ]
    },
    {
      "name": "setSessionKey",
      "discriminator": [
        13,
        147,
        179,
        38,
        67,
        1,
        69,
        132
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "profile",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": "pubkey"
        },
        {
          "name": "ttlSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setStop",
      "discriminator": [
        231,
        201,
        169,
        101,
        182,
        97,
        251,
        98
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "The trader wallet, or a session key authorised by it (see `session`)."
          ],
          "signer": true
        },
        {
          "name": "trader",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "session",
          "docs": [
            "Optional trade-only session key for `trader` (`set_session_key`). Pass `None` when the wallet signs."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setStopArgs"
            }
          }
        }
      ]
    },
    {
      "name": "settleCommonPull",
      "discriminator": [
        38,
        150,
        207,
        243,
        215,
        196,
        160,
        67
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Normally the keeper. Receives the stake account's rent",
            "when the stake is fully exited."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "stake",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "commonPool"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "settleCommonRedemption",
      "discriminator": [
        239,
        229,
        69,
        90,
        189,
        16,
        72,
        70
      ],
      "accounts": [
        {
          "name": "investor",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "settleRedemption",
      "discriminator": [
        21,
        217,
        64,
        236,
        36,
        148,
        2,
        161
      ],
      "accounts": [
        {
          "name": "investor",
          "writable": true,
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "investorUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "skipDeadTicket",
      "discriminator": [
        242,
        71,
        48,
        239,
        108,
        30,
        99,
        108
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Normally the keeper."
          ],
          "signer": true
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.trader",
                "account": "fundingTicket"
              }
            ]
          }
        },
        {
          "name": "rentTo",
          "writable": true
        },
        {
          "name": "profile",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket.trader",
                "account": "fundingTicket"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "sweepDust",
      "discriminator": [
        9,
        49,
        242,
        88,
        156,
        84,
        109,
        15
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "sweepForfeitedFee",
      "docs": [
        "Permissionless: hand a failed/locked trader's forfeited entry fee to the",
        "CommonPool, where it raises NAV/share for the investors."
      ],
      "discriminator": [
        145,
        208,
        33,
        187,
        146,
        82,
        72,
        214
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Normally the keeper."
          ],
          "signer": true
        },
        {
          "name": "trader",
          "docs": [
            "looked up by seed, so this cannot point at someone else's."
          ]
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "commonVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "unwindAll",
      "discriminator": [
        4,
        76,
        50,
        157,
        11,
        185,
        144,
        130
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "profile",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "The pool's USDC vault. The bounty is charged here first, against the",
            "trader's first-loss seed, before the communal reserve is touched."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "callerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "unwindForRedemption",
      "discriminator": [
        53,
        68,
        49,
        22,
        128,
        152,
        31,
        18
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "position.investor",
                "account": "investorPosition"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "callerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "updateCommonPoolParams",
      "discriminator": [
        229,
        245,
        131,
        243,
        126,
        118,
        244,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "commonPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  111,
                  110,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "commonPoolParams"
            }
          }
        }
      ]
    },
    {
      "name": "updateRiskParams",
      "discriminator": [
        106,
        101,
        226,
        66,
        22,
        113,
        174,
        212
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateParamsArgs"
            }
          }
        }
      ]
    },
    {
      "name": "vestEscrow",
      "discriminator": [
        142,
        55,
        53,
        35,
        75,
        225,
        197,
        1
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdrawTreasury",
      "discriminator": [
        40,
        63,
        122,
        158,
        144,
        216,
        83,
        96
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "commonPool",
      "discriminator": [
        173,
        81,
        167,
        105,
        45,
        246,
        93,
        48
      ]
    },
    {
      "name": "commonPosition",
      "discriminator": [
        70,
        240,
        212,
        79,
        186,
        177,
        140,
        67
      ]
    },
    {
      "name": "fundingTicket",
      "discriminator": [
        89,
        115,
        59,
        46,
        124,
        126,
        213,
        2
      ]
    },
    {
      "name": "investorPosition",
      "discriminator": [
        145,
        143,
        236,
        150,
        229,
        40,
        195,
        88
      ]
    },
    {
      "name": "marketRegistry",
      "discriminator": [
        200,
        118,
        217,
        126,
        179,
        169,
        172,
        104
      ]
    },
    {
      "name": "mockOracle",
      "discriminator": [
        208,
        74,
        71,
        99,
        160,
        22,
        158,
        240
      ]
    },
    {
      "name": "platformConfig",
      "discriminator": [
        160,
        78,
        128,
        0,
        248,
        83,
        230,
        160
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    },
    {
      "name": "sessionKey",
      "discriminator": [
        93,
        186,
        163,
        139,
        160,
        255,
        81,
        112
      ]
    },
    {
      "name": "traderProfile",
      "discriminator": [
        99,
        135,
        170,
        100,
        49,
        79,
        225,
        169
      ]
    },
    {
      "name": "treasury",
      "discriminator": [
        238,
        239,
        123,
        238,
        89,
        1,
        168,
        253
      ]
    }
  ],
  "events": [
    {
      "name": "bountyPaid",
      "discriminator": [
        60,
        72,
        10,
        171,
        122,
        59,
        238,
        148
      ]
    },
    {
      "name": "commonDeposited",
      "discriminator": [
        218,
        255,
        1,
        207,
        121,
        51,
        120,
        17
      ]
    },
    {
      "name": "commonPullRequested",
      "discriminator": [
        186,
        47,
        84,
        234,
        187,
        236,
        183,
        198
      ]
    },
    {
      "name": "commonPullSettled",
      "discriminator": [
        187,
        172,
        0,
        23,
        42,
        193,
        226,
        215
      ]
    },
    {
      "name": "commonRedemptionRequested",
      "discriminator": [
        215,
        194,
        5,
        117,
        154,
        83,
        35,
        139
      ]
    },
    {
      "name": "commonRedemptionSettled",
      "discriminator": [
        34,
        155,
        225,
        137,
        1,
        109,
        132,
        177
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "entryFeeRefunded",
      "discriminator": [
        105,
        81,
        244,
        207,
        51,
        32,
        48,
        0
      ]
    },
    {
      "name": "escrowVested",
      "discriminator": [
        0,
        180,
        216,
        145,
        89,
        20,
        41,
        101
      ]
    },
    {
      "name": "feesClaimed",
      "discriminator": [
        22,
        104,
        110,
        222,
        38,
        157,
        14,
        62
      ]
    },
    {
      "name": "forfeitedFeeSwept",
      "discriminator": [
        246,
        160,
        95,
        168,
        56,
        92,
        231,
        72
      ]
    },
    {
      "name": "fundingQueued",
      "discriminator": [
        31,
        130,
        229,
        12,
        121,
        4,
        89,
        34
      ]
    },
    {
      "name": "marketRemoved",
      "discriminator": [
        216,
        73,
        177,
        100,
        76,
        12,
        211,
        140
      ]
    },
    {
      "name": "navMarked",
      "discriminator": [
        184,
        75,
        236,
        156,
        164,
        122,
        163,
        170
      ]
    },
    {
      "name": "platformFeeCollected",
      "discriminator": [
        44,
        79,
        0,
        185,
        164,
        86,
        134,
        83
      ]
    },
    {
      "name": "platformPaused",
      "discriminator": [
        110,
        72,
        152,
        13,
        0,
        222,
        149,
        129
      ]
    },
    {
      "name": "poolActivated",
      "discriminator": [
        201,
        79,
        203,
        77,
        3,
        105,
        233,
        1
      ]
    },
    {
      "name": "poolClosed",
      "discriminator": [
        106,
        46,
        29,
        231,
        42,
        44,
        73,
        119
      ]
    },
    {
      "name": "poolCreated",
      "discriminator": [
        202,
        44,
        41,
        88,
        104,
        220,
        157,
        82
      ]
    },
    {
      "name": "poolFundedFromQueue",
      "discriminator": [
        177,
        150,
        218,
        124,
        19,
        182,
        171,
        196
      ]
    },
    {
      "name": "poolLocked",
      "discriminator": [
        222,
        161,
        104,
        177,
        64,
        73,
        79,
        149
      ]
    },
    {
      "name": "poolReaped",
      "discriminator": [
        235,
        0,
        79,
        90,
        3,
        171,
        70,
        245
      ]
    },
    {
      "name": "poolUnwound",
      "discriminator": [
        171,
        103,
        61,
        4,
        199,
        136,
        224,
        20
      ]
    },
    {
      "name": "queueTicketSkipped",
      "discriminator": [
        243,
        27,
        58,
        34,
        230,
        203,
        59,
        80
      ]
    },
    {
      "name": "redemptionRequested",
      "discriminator": [
        245,
        155,
        98,
        131,
        210,
        25,
        137,
        146
      ]
    },
    {
      "name": "redemptionSettled",
      "discriminator": [
        75,
        9,
        197,
        96,
        249,
        61,
        27,
        245
      ]
    },
    {
      "name": "sessionKeySet",
      "discriminator": [
        94,
        76,
        244,
        82,
        192,
        95,
        235,
        199
      ]
    },
    {
      "name": "stopSet",
      "discriminator": [
        17,
        203,
        150,
        9,
        44,
        241,
        158,
        63
      ]
    },
    {
      "name": "tierPromoted",
      "discriminator": [
        186,
        104,
        35,
        248,
        80,
        75,
        207,
        121
      ]
    },
    {
      "name": "tradeFilled",
      "discriminator": [
        178,
        143,
        149,
        27,
        109,
        147,
        88,
        118
      ]
    },
    {
      "name": "traderApplied",
      "discriminator": [
        138,
        124,
        192,
        9,
        178,
        59,
        208,
        110
      ]
    },
    {
      "name": "trialFinalized",
      "discriminator": [
        22,
        241,
        80,
        188,
        115,
        171,
        5,
        52
      ]
    },
    {
      "name": "trialRootCommitted",
      "discriminator": [
        243,
        211,
        87,
        146,
        223,
        214,
        108,
        212
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Platform is paused"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6002,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6003,
      "name": "invalidArgument",
      "msg": "Invalid argument"
    },
    {
      "code": 6004,
      "name": "invalidTraderStatus",
      "msg": "Trader already has an active profile state that forbids this action"
    },
    {
      "code": 6005,
      "name": "inCooldown",
      "msg": "Trader is in post-failure cooldown"
    },
    {
      "code": 6006,
      "name": "trialDayOutOfOrder",
      "msg": "Trial day must be committed sequentially and on time"
    },
    {
      "code": 6007,
      "name": "trialDayNotComplete",
      "msg": "Trial day is not yet complete"
    },
    {
      "code": 6008,
      "name": "trialNotComplete",
      "msg": "Trial has not reached its full duration"
    },
    {
      "code": 6009,
      "name": "notEligible",
      "msg": "Trader is not eligible"
    },
    {
      "code": 6010,
      "name": "poolAlreadyExists",
      "msg": "Trader already has a live pool"
    },
    {
      "code": 6011,
      "name": "invalidPoolStatus",
      "msg": "Pool is not in the required status"
    },
    {
      "code": 6012,
      "name": "belowActivationFloor",
      "msg": "Pool NAV is below the activation floor"
    },
    {
      "code": 6013,
      "name": "promotionConditionsNotMet",
      "msg": "Promotion conditions not met"
    },
    {
      "code": 6014,
      "name": "positionsOpen",
      "msg": "Pool has open positions"
    },
    {
      "code": 6015,
      "name": "sharesOutstanding",
      "msg": "Pool still has investor shares outstanding"
    },
    {
      "code": 6016,
      "name": "maxTier",
      "msg": "Already at maximum tier"
    },
    {
      "code": 6017,
      "name": "insufficientFirstLoss",
      "msg": "Not enough earned profit to fund the first-loss cushion for the next tier: keep trading, or claim the profit and stay at this cap"
    },
    {
      "code": 6018,
      "name": "marketStillEnabled",
      "msg": "Market must be disabled before it can be removed"
    },
    {
      "code": 6019,
      "name": "depositTooSmall",
      "msg": "Deposit below minimum"
    },
    {
      "code": 6020,
      "name": "exceedsTierCap",
      "msg": "Deposit would exceed the tier cap"
    },
    {
      "code": 6021,
      "name": "lockupActive",
      "msg": "Redemption lockup has not elapsed"
    },
    {
      "code": 6022,
      "name": "insufficientShares",
      "msg": "Insufficient shares"
    },
    {
      "code": 6023,
      "name": "redemptionPending",
      "msg": "A redemption is already pending"
    },
    {
      "code": 6024,
      "name": "noRedemptionPending",
      "msg": "No redemption pending"
    },
    {
      "code": 6025,
      "name": "unwindRequired",
      "msg": "Redemption requires an unwind before settlement"
    },
    {
      "code": 6026,
      "name": "notTraderDelegate",
      "msg": "Signer is not the registered trader delegate"
    },
    {
      "code": 6027,
      "name": "marketNotFound",
      "msg": "Market not found in registry"
    },
    {
      "code": 6028,
      "name": "marketDisabled",
      "msg": "Market is disabled"
    },
    {
      "code": 6029,
      "name": "oracleMissing",
      "msg": "Oracle account missing for a market"
    },
    {
      "code": 6030,
      "name": "oracleStale",
      "msg": "Oracle is stale"
    },
    {
      "code": 6031,
      "name": "oracleConfidence",
      "msg": "Oracle confidence too wide"
    },
    {
      "code": 6032,
      "name": "oracleInvalid",
      "msg": "Oracle account invalid"
    },
    {
      "code": 6033,
      "name": "dailyLossBreach",
      "msg": "Daily loss cap breached"
    },
    {
      "code": 6034,
      "name": "drawdownBreach",
      "msg": "Max drawdown breached"
    },
    {
      "code": 6035,
      "name": "tooManyPositions",
      "msg": "Too many open positions"
    },
    {
      "code": 6036,
      "name": "leverageExceeded",
      "msg": "Gross leverage limit exceeded"
    },
    {
      "code": 6037,
      "name": "singlePositionExceeded",
      "msg": "Single position limit exceeded"
    },
    {
      "code": 6038,
      "name": "clusterExceeded",
      "msg": "Cluster exposure limit exceeded"
    },
    {
      "code": 6039,
      "name": "limitOutOfBand",
      "msg": "Limit price outside the oracle band"
    },
    {
      "code": 6040,
      "name": "positionNotFound",
      "msg": "Position not found"
    },
    {
      "code": 6041,
      "name": "oppositeSide",
      "msg": "Opposite-side order on an open position: use close_trade"
    },
    {
      "code": 6042,
      "name": "minHoldTime",
      "msg": "Minimum holding time not elapsed"
    },
    {
      "code": 6043,
      "name": "tooManyTrades",
      "msg": "Max trades per day reached"
    },
    {
      "code": 6044,
      "name": "sizeTooSmall",
      "msg": "Trade size too small"
    },
    {
      "code": 6045,
      "name": "limitNotMet",
      "msg": "Fill would exceed limit price"
    },
    {
      "code": 6046,
      "name": "stopWrongSide",
      "msg": "Stop must sit below the mark on a long and above it on a short"
    },
    {
      "code": 6047,
      "name": "noBreach",
      "msg": "No risk breach detected"
    },
    {
      "code": 6048,
      "name": "nothingToUnwind",
      "msg": "Nothing to unwind"
    },
    {
      "code": 6049,
      "name": "venueUnavailable",
      "msg": "Venue adapter not available in this build"
    },
    {
      "code": 6050,
      "name": "bountyReserveProtected",
      "msg": "Withdrawal would dip into the ring-fenced bounty reserve"
    },
    {
      "code": 6051,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6052,
      "name": "belowHighWaterMark",
      "msg": "NAV per share is below the high-water mark"
    },
    {
      "code": 6053,
      "name": "mockOracleDisabled",
      "msg": "Mock oracle is disabled on this deployment"
    },
    {
      "code": 6054,
      "name": "registryFull",
      "msg": "Registry is full"
    },
    {
      "code": 6055,
      "name": "venueAccountsMissing",
      "msg": "Venue accounts missing from remaining accounts"
    },
    {
      "code": 6056,
      "name": "venueAccountInvalid",
      "msg": "Venue account does not match the pool's venue sub-account or vault"
    },
    {
      "code": 6057,
      "name": "venueLayoutInvalid",
      "msg": "Venue account data has an unexpected layout"
    },
    {
      "code": 6058,
      "name": "venueNoFill",
      "msg": "Venue returned no fill"
    },
    {
      "code": 6059,
      "name": "venueMarketUnknown",
      "msg": "Venue holds a position on a market that is not in the registry"
    },
    {
      "code": 6060,
      "name": "insufficientVaultLiquidity",
      "msg": "Pool vault lacks USDC for this payout: settle venue PnL and retry"
    },
    {
      "code": 6061,
      "name": "poolExpired",
      "msg": "Pool has reached its end date: no new deposits or trades"
    },
    {
      "code": 6062,
      "name": "notPoolTrader",
      "msg": "Only the pool's trader may do this (or anyone, once the pool has expired)"
    },
    {
      "code": 6063,
      "name": "commonDepositsDisabled",
      "msg": "CommonPool deposits are disabled on this deployment"
    },
    {
      "code": 6064,
      "name": "wrongStakeAccounts",
      "msg": "deposit_common needs exactly one (pool, position) pair per active stake, in ascending pool order"
    },
    {
      "code": 6065,
      "name": "ticketOutOfOrder",
      "msg": "Only the ticket at the head of the funding queue can be processed"
    },
    {
      "code": 6066,
      "name": "insufficientIdleReserve",
      "msg": "CommonPool idle reserve cannot cover this allocation"
    },
    {
      "code": 6067,
      "name": "queueVenueUnsupported",
      "msg": "The funding queue only funds MockPerps pools until the Drift path is verified"
    },
    {
      "code": 6068,
      "name": "noPullNeeded",
      "msg": "The CommonPool has no redemption backlog to pull for"
    },
    {
      "code": 6069,
      "name": "idleShortfall",
      "msg": "The CommonPool's idle reserve does not yet cover this settlement. It refills when a pool locks"
    },
    {
      "code": 6070,
      "name": "poolNotLocked",
      "msg": "Only a locked pool's capital is pulled back. A healthy pool is never redeemed out from under its trader"
    },
    {
      "code": 6071,
      "name": "feeNotForfeited",
      "msg": "This trader's fee is not forfeit: their attempt is still live, or there is nothing held"
    },
    {
      "code": 6072,
      "name": "directDepositDisabled",
      "msg": "Investors cannot fund a trader directly. Deposit into the CommonPool, which funds traders in queue order. `deposit` seeds a trader's own pool to the activation floor and is theirs alone"
    },
    {
      "code": 6073,
      "name": "claimGraceActive",
      "msg": "The trader's claim window on a voluntarily closed pool has not expired. Their escrow cannot be folded into the reap yet"
    }
  ],
  "types": [
    {
      "name": "bountyPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "closeTradeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "baseQty",
            "docs": [
              "Base quantity to close (1e9 scale); 0 = entire position."
            ],
            "type": "u64"
          },
          {
            "name": "limitPx",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "commonDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "navAfter",
            "docs": [
              "idle + Σ book value of stakes, after this deposit."
            ],
            "type": "u64"
          },
          {
            "name": "totalSharesAfter",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "commonPool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalShares",
            "docs": [
              "Investor shares outstanding (scaled 1e12, like pool shares)."
            ],
            "type": "u128"
          },
          {
            "name": "accountedIdle",
            "docs": [
              "USDC the program accounts for in the common vault. Anything above this",
              "in the vault is dust. NAV never reads the raw balance, so donations",
              "can't move the share price (section 5.1 discipline, one layer up)."
            ],
            "type": "u64"
          },
          {
            "name": "activeStakes",
            "docs": [
              "Trader pools the CommonPool currently holds a stake in. `deposit_common`",
              "requires exactly this many (pool, position) pairs so NAV can't be",
              "understated by omitting a pool."
            ],
            "type": "u16"
          },
          {
            "name": "nextTicket",
            "docs": [
              "Next FIFO ticket number to hand out."
            ],
            "type": "u64"
          },
          {
            "name": "nextToFund",
            "docs": [
              "Head of the queue. `fund_next_in_queue` only ever processes this ticket."
            ],
            "type": "u64"
          },
          {
            "name": "reserveBps",
            "docs": [
              "Idle reserve floor, bps of idle balance, never deployed to traders."
            ],
            "type": "u16"
          },
          {
            "name": "depositEnabled",
            "docs": [
              "Testnet gate (Vault Ledger section 7): no real deposits before redemption ships."
            ],
            "type": "bool"
          },
          {
            "name": "depositedTotal",
            "type": "u64"
          },
          {
            "name": "fundedTotal",
            "type": "u64"
          },
          {
            "name": "pendingRedemptionShares",
            "docs": [
              "Investor shares queued for redemption (Phase B). Burned at settlement."
            ],
            "type": "u128"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "commonPoolParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserveBps",
            "docs": [
              "Idle reserve floor, bps of idle balance, never deployed to traders."
            ],
            "type": "u16"
          },
          {
            "name": "depositEnabled",
            "docs": [
              "Testnet gate: no deposits before the redemption cascade ships."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "commonPosition",
      "docs": [
        "An investor's stake in the CommonPool (not in any single trader)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "costBasis",
            "docs": [
              "Sum of deposits, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "lastDepositTs",
            "type": "i64"
          },
          {
            "name": "pendingShares",
            "docs": [
              "Shares queued for redemption (Phase B); burned at settlement."
            ],
            "type": "u128"
          },
          {
            "name": "requestedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "commonPullRequested",
      "docs": [
        "The CommonPool pulling capital back from a trader pool to serve redemptions."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "commonPullSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "unwindCost",
            "type": "u64"
          },
          {
            "name": "stakeClosed",
            "docs": [
              "True when the CommonPool's stake in this pool is fully exited (position closed)."
            ],
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "commonRedemptionRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "immediate",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "commonRedemptionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "navAfter",
            "type": "u64"
          },
          {
            "name": "totalSharesAfter",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "createPoolArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mandate",
            "type": {
              "defined": {
                "name": "mandate"
              }
            }
          },
          {
            "name": "targetSize",
            "type": "u64"
          },
          {
            "name": "strategyHash",
            "docs": [
              "sha256 of the strategy description stored off-chain by the indexer."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "venue",
            "type": {
              "defined": {
                "name": "venue"
              }
            }
          },
          {
            "name": "durationDays",
            "docs": [
              "Pool lifetime in platform days (cfg.trial.day_secs each); 0 = open-ended.",
              "Appended last: the pre-duration program deserializes its prefix and ignores it."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "navPerShare",
            "type": "u128"
          },
          {
            "name": "navAfter",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "entryFeeRefunded",
      "docs": [
        "Retired by the Vault Ledger fee model (the fee is first-loss seed capital",
        "now, never refunded). Kept so old indexed events still decode."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "escrowBucket",
      "docs": [
        "One daily escrow bucket (section 5.2): 12 bytes, 30 slots = 360 bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "unlockDay",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "escrowVested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "vestedClaimable",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feesClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "forfeitedFeeSwept",
      "docs": [
        "The 5% platform performance fee swept from a pool to the treasury",
        "(half replenishes the keeper bounty reserve, half is revenue).",
        "A held entry/instant fee whose attempt ended without funding (failed trial",
        "or breach lock) was handed to the CommonPool, where it raises NAV/share with",
        "no new shares behind it, so it accrues to the investors who were carrying",
        "the platform while the attempt ran."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "toCommon",
            "docs": [
              "Into the CommonPool's idle balance, as investor value."
            ],
            "type": "u64"
          },
          {
            "name": "toTreasury",
            "docs": [
              "To treasury revenue instead, when the CommonPool has no shares to price",
              "the value against (same fallback as `reap_pool`)."
            ],
            "type": "u64"
          },
          {
            "name": "remaining",
            "docs": [
              "Still held on the profile because the treasury vault could not cover it."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundingQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundingTicket",
      "docs": [
        "One place in the funding queue. PDA per trader, so double-queuing is",
        "structurally impossible; closed (rent back to `payer`) when funded."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "Who paid the ticket rent (queue_for_funding is permissionless)."
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "initPlatformArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trialAttestor",
            "type": "pubkey"
          },
          {
            "name": "priceAuthority",
            "type": "pubkey"
          },
          {
            "name": "entryFee",
            "type": "u64"
          },
          {
            "name": "bountyPerPool",
            "type": "u64"
          },
          {
            "name": "keeperBounty",
            "type": "u64"
          },
          {
            "name": "activationFloor",
            "type": "u64"
          },
          {
            "name": "minDeposit",
            "type": "u64"
          },
          {
            "name": "tierCaps",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "vestDays",
            "type": {
              "array": [
                "u16",
                3
              ]
            }
          },
          {
            "name": "allowMockOracle",
            "type": "bool"
          },
          {
            "name": "minFirstLossBps",
            "type": "u16"
          },
          {
            "name": "risk",
            "type": {
              "option": {
                "defined": {
                  "name": "riskParams"
                }
              }
            }
          },
          {
            "name": "trial",
            "type": {
              "option": {
                "defined": {
                  "name": "trialCriteria"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "investorPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "costBasis",
            "docs": [
              "Sum of deposits, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "lastDepositTs",
            "type": "i64"
          },
          {
            "name": "pendingShares",
            "docs": [
              "Shares queued for redemption (burned at settlement, section 4.7)."
            ],
            "type": "u128"
          },
          {
            "name": "requestedAt",
            "type": "i64"
          },
          {
            "name": "unwound",
            "docs": [
              "Pro-rata unwind already executed for the pending redemption."
            ],
            "type": "bool"
          },
          {
            "name": "unwindCost",
            "docs": [
              "Slippage + fees of the investor's own unwind; borne by the exiting investor."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mandate",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "spot"
          },
          {
            "name": "perps"
          }
        ]
      }
    },
    {
      "name": "marketInfo",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "symbol",
            "docs": [
              "ASCII symbol, zero padded (e.g. \"SOL-PERP\")."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "oracle",
            "docs": [
              "Oracle account: either a Pyth `PriceUpdateV2` or this program's `MockOracle`."
            ],
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "docs": [
              "Pyth feed id the oracle account must carry (ignored for mock oracles)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxLeverageBps",
            "docs": [
              "Per-market leverage cap, bps."
            ],
            "type": "u32"
          },
          {
            "name": "cluster",
            "type": "u8"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "venueMarketIndex",
            "docs": [
              "Drift perp market index for the DriftAdapter (unused by MockPerps)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "marketRegistry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "markets",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "marketInfo"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "count",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "remaining",
            "docs": [
              "Markets left in the registry after the removal."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mockOracle",
      "docs": [
        "Program-owned oracle for devnet / tests. The keeper's price gateway pushes",
        "Pyth Hermes prices here when a Pyth `PriceUpdateV2` account is not available.",
        "Gated by `PlatformConfig.allow_mock_oracle`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "expo",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "type": "i64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "navMarked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "nav",
            "docs": [
              "Total pool equity. What the loss limits and the health factor measure."
            ],
            "type": "u64"
          },
          {
            "name": "investorNav",
            "docs": [
              "Investor-redeemable NAV: `nav` minus whatever is left of the trader's",
              "first-loss seed. `nav_per_share` is priced off this, not off `nav`."
            ],
            "type": "u64"
          },
          {
            "name": "navPerShare",
            "type": "u128"
          },
          {
            "name": "peakNav",
            "type": "u64"
          },
          {
            "name": "dayStartNav",
            "type": "u64"
          },
          {
            "name": "hwmNps",
            "type": "u128"
          },
          {
            "name": "grossNotional",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "placeTradeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "side",
            "docs": [
              "1 = long, 2 = short"
            ],
            "type": "u8"
          },
          {
            "name": "notional",
            "docs": [
              "Order size as USDC notional (base units)."
            ],
            "type": "u64"
          },
          {
            "name": "limitPx",
            "docs": [
              "0 = market order; otherwise a limit within `limit_band_bps` of oracle."
            ],
            "type": "u64"
          },
          {
            "name": "stopPx",
            "docs": [
              "Optional stop trigger, 1e6. 0 = none. When set it must sit below the mark",
              "on a long / above it on a short, replaces any existing stop on this",
              "market, and covers the whole resulting position. Not just the quantity",
              "added here."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "platformConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "The only key that can change params, pause, or withdraw revenue.",
              "",
              "A single `Pubkey`, not a multisig. An earlier version of this comment",
              "said \"(multisig)\" and nothing in the program has ever enforced that.",
              "It is also write-once: `init_platform` sets it and no instruction",
              "changes it, so rotating the admin needs a program upgrade."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "trialAttestor",
            "docs": [
              "Trial engine key that attests trial metrics to `finalize_trial`."
            ],
            "type": "pubkey"
          },
          {
            "name": "priceAuthority",
            "docs": [
              "Key allowed to push mock-oracle prices (devnet only)."
            ],
            "type": "pubkey"
          },
          {
            "name": "entryFee",
            "docs": [
              "Entry fee, USDC base units. `config/platform.jsonc` ships 800, not the",
              "$500 this comment claimed; treat the config file as the source of truth",
              "and this field as whatever `init_platform` was given."
            ],
            "type": "u64"
          },
          {
            "name": "bountyPerPool",
            "docs": [
              "**Vestigial. Read by nothing.** Under the Vault Ledger fee model the",
              "entry fee is held in treasury-vault custody and split at funding time by",
              "`fund_next_in_queue`: `min_first_loss_bps` of the cap becomes the pool's",
              "first-loss seed and the surplus is divided by `PLATFORM_FEE_BOUNTY_BPS`.",
              "Nothing reads this field. It is kept (and still bounded by `entry_fee`)",
              "only so the account layout and the IDL are unchanged; set it to 0."
            ],
            "type": "u64"
          },
          {
            "name": "keeperBounty",
            "docs": [
              "Bounty paid per permissionless lock / unwind call."
            ],
            "type": "u64"
          },
          {
            "name": "activationFloor",
            "docs": [
              "Pool activates at ≥ this NAV ($1,000)."
            ],
            "type": "u64"
          },
          {
            "name": "minDeposit",
            "docs": [
              "Minimum investor deposit ($50)."
            ],
            "type": "u64"
          },
          {
            "name": "tierCaps",
            "docs": [
              "Per-tier pool caps ($5k / $15k / $30k)."
            ],
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "vestDays",
            "docs": [
              "Per-tier vesting periods in days (14 / 30 / 30)."
            ],
            "type": {
              "array": [
                "u16",
                3
              ]
            }
          },
          {
            "name": "risk",
            "type": {
              "defined": {
                "name": "riskParams"
              }
            }
          },
          {
            "name": "trial",
            "type": {
              "defined": {
                "name": "trialCriteria"
              }
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "allowMockOracle",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "treasuryBump",
            "type": "u8"
          },
          {
            "name": "treasuryVaultBump",
            "type": "u8"
          },
          {
            "name": "minFirstLossBps",
            "docs": [
              "Trader first-loss required to fund a pool, in bps of the pool's tier cap.",
              "Must cover the drawdown trigger plus the liquidation buffer at the",
              "platform leverage cap: at 5x over a 60s mark window (the 150-slot",
              "staleness bound the shipped configs use) that is 10% + 5.71% = 1_571",
              "bps. Raising `risk.max_leverage_bps` or `risk.oracle_max_age_slots`",
              "widens the buffer and so must raise this too. `RiskParams::mvp_defaults`",
              "and `config/platform.jsonc` are both sized against this figure.",
              "",
              "Appended: migrate_account zero-fills. Zero disables the cushion gate,",
              "which is the pre-upgrade behaviour."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "platformFeeCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "toBountyReserve",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "platformPaused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "profile",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "mandate",
            "type": {
              "defined": {
                "name": "mandate"
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "poolStatus"
              }
            }
          },
          {
            "name": "lockReason",
            "type": "u8"
          },
          {
            "name": "venue",
            "type": {
              "defined": {
                "name": "venue"
              }
            }
          },
          {
            "name": "vault",
            "docs": [
              "PDA-owned USDC token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "venueAccount",
            "docs": [
              "Venue sub-account (Drift user account) owned by the pool PDA. Unused for MockPerps."
            ],
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "strategyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "targetSize",
            "type": "u64"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "tierStartTs",
            "type": "i64"
          },
          {
            "name": "tierStartNps",
            "docs": [
              "NAV/share at tier start. Promotion requires positive NAV/share vs. this."
            ],
            "type": "u128"
          },
          {
            "name": "liveDaysAtTier",
            "type": "u16"
          },
          {
            "name": "lastLiveDay",
            "docs": [
              "Last UTC day (epoch days) on which the pool was observed Live."
            ],
            "type": "u32"
          },
          {
            "name": "accountedUsdc",
            "docs": [
              "USDC the program accounts for. Anything above this in the vault is dust (section 5.1)."
            ],
            "type": "u64"
          },
          {
            "name": "totalShares",
            "type": "u128"
          },
          {
            "name": "hwmNps",
            "docs": [
              "High-water mark of investor-visible NAV per share, never decreases."
            ],
            "type": "u128"
          },
          {
            "name": "peakNav",
            "type": "u64"
          },
          {
            "name": "dayStartNav",
            "type": "u64"
          },
          {
            "name": "dayEpoch",
            "type": "u32"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "venueFeesPaid",
            "type": "u64"
          },
          {
            "name": "escrow",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "escrowBucket"
                  }
                },
                30
              ]
            }
          },
          {
            "name": "escrowTotal",
            "type": "u64"
          },
          {
            "name": "vestedClaimable",
            "type": "u64"
          },
          {
            "name": "positions",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "position"
                  }
                },
                5
              ]
            }
          },
          {
            "name": "openPositions",
            "type": "u8"
          },
          {
            "name": "tradesToday",
            "type": "u16"
          },
          {
            "name": "totalTrades",
            "type": "u32"
          },
          {
            "name": "pendingRedemptionShares",
            "type": "u128"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "activatedAt",
            "type": "i64"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          },
          {
            "name": "lastMarkTs",
            "type": "i64"
          },
          {
            "name": "lastMarkNav",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "endsAt",
            "docs": [
              "Unix time after which the pool takes no deposits and opens no new trades;",
              "close_pool becomes permissionless. 0 = open-ended (the spec default).",
              "NOTE: appended field. Pools created before this field existed cannot be",
              "deserialized by this program version (devnet: close/reap them pre-upgrade)."
            ],
            "type": "i64"
          },
          {
            "name": "platformFeeOwed",
            "docs": [
              "Uncollected platform performance fee (5% of realized profit, Vault Ledger",
              "Section 6). Excluded from NAV; swept to the treasury by `collect_platform_fee`.",
              "Appended: migrate_account zero-fills = nothing owed by pre-upgrade pools."
            ],
            "type": "u64"
          },
          {
            "name": "stops",
            "docs": [
              "Optional stop per open position, keyed by market. A trader tool, not a",
              "risk control: the platform sets loss limits and enforces them by",
              "liquidation, it does not dictate how a trader trades. 0 = no stop.",
              "Appended: migrate_account zero-fills, which simply means no stops."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "stopOrder"
                  }
                },
                5
              ]
            }
          },
          {
            "name": "venueAccountedQuote",
            "docs": [
              "Baseline for venue-side realizations the program has already accounted",
              "for, so a close *it* did not perform. A stop filled by Drift's keepers,",
              "a liquidation, an ADL. Still runs through the profit split instead of",
              "silently leaving the trader's escrow un-clawed-back.",
              "",
              "Measured against `observed = venue USDC balance + Σ quote_asset over",
              "flat perp slots`, which equals `net deposits + every realization the",
              "venue has produced`. `settle_pnl` only moves value between those two",
              "terms, so the observed total (and therefore this baseline) is",
              "invariant under settlement. `sync_venue` splits `observed − this` and",
              "then stores `observed`; deposits, withdrawals and the program's own",
              "closes move it directly. Any drift between the program's arithmetic and",
              "the venue's is picked up as the next delta, so the mechanism converges",
              "rather than losing value.",
              "",
              "Zero and unused for MockPerps, which has no separate venue account.",
              "",
              "Appended, so `migrate_account` zero-fills it. Correct for any pool that",
              "has never deposited to a venue, which is every pool today (no Drift pool",
              "has ever been funded). **A pre-existing Drift pool holding venue",
              "collateral must not be migrated blind:** a zero baseline against a",
              "non-zero balance reads the whole deposit as profit and hands the trader",
              "80% of it as escrow. Such a pool has to be seeded with its current",
              "`usdc_balance + Σ quote over flat slots` instead."
            ],
            "type": "i64"
          },
          {
            "name": "firstLossSeed",
            "docs": [
              "Trader capital standing in front of investors, in USDC. Holds no shares,",
              "so it is pure first loss: it is spent before investor NAV/share moves.",
              "",
              "The invariant is `first_loss_seed >= min_first_loss_bps x pool cap`,",
              "which covers the drawdown trigger *and* the liquidation buffer beyond",
              "it, so a blowup costs the trader, not the investors. Seeded from the",
              "entry/instant fee at funding and topped up at promotion out of the",
              "trader's own escrow, never from cash.",
              "",
              "Appended: migrate_account zero-fills, which blocks promotion until the",
              "pool's cushion is re-established rather than silently under-funding it."
            ],
            "type": "u64"
          },
          {
            "name": "investorPrincipal",
            "docs": [
              "Investor cash in this pool: the CommonPool's allocation at funding, plus",
              "every deposit, minus every payout. It is the reference the first-loss",
              "seed is measured against, not a share count. Shares float, this does not.",
              "",
              "`remaining_first_loss = clamp(equity - investor_principal, 0, first_loss_seed)`",
              "and `investor_nav = equity - remaining_first_loss`. That is what makes",
              "the seed a *cushion* rather than a windfall: at funding the pool's equity",
              "is `allocation + seed` but investors are priced at `allocation`, so",
              "NAV/share is exactly 1.0 and a trader signing up does not make the",
              "CommonPool look instantly profitable. Trading losses then eat the gap",
              "before investor NAV moves at all, and the money the liquidation buffer",
              "is sized against cannot be withdrawn out from under it.",
              "",
              "Appended: `migrate_account` zero-fills, and `realloc(zero_init)` clears",
              "every byte past the old length, so on a pool predating `e28fa1b`",
              "`first_loss_seed` lands at 0 too. `min(equity - 0, 0) == 0`: investor NAV",
              "reads as the whole equity, the cushion is gone, and exits are OVER-paid.",
              "On a pool created between `e28fa1b` and `5226575` only this field",
              "zero-fills, `remaining_first_loss` becomes a constant reserve, and exits",
              "are UNDER-paid by the seed pro-rata. The first case turns into the second",
              "the moment anyone calls the permissionless `promote_tier`, which raises",
              "`first_loss_seed` without touching this field. No on-chain setter exists:",
              "reap and re-fund such a pool; do not migrate one with shares outstanding."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolActivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "nav",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "mandate",
            "type": "u8"
          },
          {
            "name": "targetSize",
            "type": "u64"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolFundedFromQueue",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "u64"
          },
          {
            "name": "allocation",
            "docs": [
              "CommonPool's tier-cap allocation (mints the CommonPool's stake)."
            ],
            "type": "u64"
          },
          {
            "name": "feeSeed",
            "docs": [
              "The trader's entry/instant fee injected as no-shares first-loss seed."
            ],
            "type": "u64"
          },
          {
            "name": "nav",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "nav",
            "type": "u64"
          },
          {
            "name": "escrowReturned",
            "type": "u64"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolReaped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "platformFee",
            "docs": [
              "Uncollected 5% platform performance fee, swept to the treasury."
            ],
            "type": "u64"
          },
          {
            "name": "toCommon",
            "docs": [
              "The investors' share of the unspent first-loss seed + dust, added to the",
              "CommonPool's idle balance against unchanged shares, so it raises",
              "NAV/share for every holder."
            ],
            "type": "u64"
          },
          {
            "name": "toTreasury",
            "docs": [
              "The platform's `REAP_PLATFORM_BPS` share of the same remainder, booked as",
              "withdrawable treasury revenue, or the whole remainder when the",
              "CommonPool has no shares outstanding and the value would be unowned."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "funding"
          },
          {
            "name": "live"
          },
          {
            "name": "locked"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "poolUnwound",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "positionsClosed",
            "type": "u8"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "navAfter",
            "type": "u64"
          },
          {
            "name": "caller",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "cluster",
            "type": "u8"
          },
          {
            "name": "baseQty",
            "docs": [
              "Base quantity, scaled 1e9."
            ],
            "type": "u64"
          },
          {
            "name": "entryPrice",
            "docs": [
              "Average entry price, 1e6."
            ],
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "queueTicketSkipped",
      "docs": [
        "A head-of-queue ticket whose trader could no longer be funded was closed",
        "and the queue advanced (permissionless unjam)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "redemptionRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "immediate",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "redemptionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u128"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "unwindCost",
            "type": "u64"
          },
          {
            "name": "navPerShare",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "registerMarketArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "oracle",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxLeverageBps",
            "type": "u32"
          },
          {
            "name": "cluster",
            "type": "u8"
          },
          {
            "name": "venueMarketIndex",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "riskParams",
      "docs": [
        "Platform-wide live risk limits (section 5.3). Fixed by the admin; traders cannot change them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxLeverageBps",
            "docs": [
              "Max gross leverage, bps of NAV (50_000 = 5×)."
            ],
            "type": "u32"
          },
          {
            "name": "maxPositions",
            "docs": [
              "Max concurrent positions (5)."
            ],
            "type": "u8"
          },
          {
            "name": "maxSingleBps",
            "docs": [
              "Max single position, bps of equity (4_000 = 40%)."
            ],
            "type": "u16"
          },
          {
            "name": "maxClusterBps",
            "docs": [
              "Max correlated cluster, bps of equity (6_000 = 60%)."
            ],
            "type": "u16"
          },
          {
            "name": "dailyLossBps",
            "docs": [
              "Daily loss cap, bps of day-start NAV (400 = 4%)."
            ],
            "type": "u16"
          },
          {
            "name": "maxDrawdownBps",
            "docs": [
              "Max total drawdown from peak NAV, bps (1_000 = 10%)."
            ],
            "type": "u16"
          },
          {
            "name": "minHoldSecs",
            "docs": [
              "Minimum holding time per position, seconds (60)."
            ],
            "type": "u32"
          },
          {
            "name": "maxTradesPerDay",
            "docs": [
              "Max trades per UTC day (100)."
            ],
            "type": "u16"
          },
          {
            "name": "oracleMaxAgeSlots",
            "docs": [
              "Oracle max age in slots (150 ≈ 60s)."
            ],
            "type": "u64"
          },
          {
            "name": "oracleMaxConfBps",
            "docs": [
              "Oracle max confidence / price, bps (50)."
            ],
            "type": "u16"
          },
          {
            "name": "limitBandBps",
            "docs": [
              "Limit price must be within this many bps of oracle (200)."
            ],
            "type": "u16"
          },
          {
            "name": "redemptionLockupSecs",
            "docs": [
              "Post-deposit redemption lockup, seconds (86_400)."
            ],
            "type": "u32"
          },
          {
            "name": "cooldownSecs",
            "docs": [
              "Cooldown after a failed trial, seconds (7 days)."
            ],
            "type": "u32"
          },
          {
            "name": "promotionDays",
            "docs": [
              "Live trading days at a tier required for promotion (30)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "sessionKey",
      "docs": [
        "Optional browser-held \"session key\" authorised by the trader wallet for a",
        "bounded time. It may sign **trade instructions only** (`place_trade`,",
        "`close_trade` and `set_stop`. Everything on the `Trade` context) on the",
        "trader's live pool. Never deposits, redemptions,",
        "pool closing, claims or anything that moves funds, so a leaked session key",
        "can at most trade within the same risk guard the trader is bound by.",
        "Seeds: [\"session\", trader wallet]. Separate PDA so `TraderProfile`'s layout",
        "is unchanged (in-place upgrade friendly)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "key",
            "type": "pubkey"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "sessionKeySet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "key",
            "docs": [
              "`Pubkey::default()` on revoke."
            ],
            "type": "pubkey"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "setStopArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "stopPx",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "stopOrder",
      "docs": [
        "The stop attached to one open position. Keyed by market rather than held in",
        "`Position` for two reasons: `sync_positions` rebuilds `positions` in venue",
        "order, so a slot-indexed parallel array would mismatch after a reorder; and",
        "a field inside `Position` would shift every `Pool` byte after the array,",
        "which `migrate_account` (append + zero-fill) cannot do."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "price",
            "docs": [
              "Trigger price, 1e6. 0 = free slot."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "stopSet",
      "docs": [
        "A stop was attached to or moved on an open position. By `place_trade` at",
        "entry or by `set_stop` afterwards. Informational: stops are a trader tool,",
        "not a risk control, so nothing in the guard depends on this."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "stopPx",
            "type": "u64"
          },
          {
            "name": "nav",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tierPromoted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "fromTier",
            "type": "u8"
          },
          {
            "name": "toTier",
            "type": "u8"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tradeFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": "u16"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "isClose",
            "type": "bool"
          },
          {
            "name": "baseQty",
            "type": "u64"
          },
          {
            "name": "fillPrice",
            "type": "u64"
          },
          {
            "name": "oraclePrice",
            "type": "u64"
          },
          {
            "name": "oracleSlot",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "positionQtyAfter",
            "type": "u64"
          },
          {
            "name": "positionEntryAfter",
            "type": "u64"
          },
          {
            "name": "navAfter",
            "type": "u64"
          },
          {
            "name": "escrowTotalAfter",
            "type": "u64"
          },
          {
            "name": "openPositions",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "traderApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "attempt",
            "type": "u16"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "trialStartTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "traderProfile",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "traderStatus"
              }
            }
          },
          {
            "name": "attempts",
            "type": "u16"
          },
          {
            "name": "trialRoot",
            "docs": [
              "Merkle root of the latest committed trial day."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "trialStartTs",
            "type": "i64"
          },
          {
            "name": "trialDaysCommitted",
            "docs": [
              "Number of days committed so far (0..=30)."
            ],
            "type": "u16"
          },
          {
            "name": "tier",
            "docs": [
              "Track record: pools created / locked, live days."
            ],
            "type": "u8"
          },
          {
            "name": "tierStartTs",
            "type": "i64"
          },
          {
            "name": "liveDaysAtTier",
            "type": "u16"
          },
          {
            "name": "poolsCreated",
            "type": "u16"
          },
          {
            "name": "poolsLocked",
            "type": "u16"
          },
          {
            "name": "trialsFailed",
            "type": "u16"
          },
          {
            "name": "cooldownUntil",
            "type": "i64"
          },
          {
            "name": "activePool",
            "docs": [
              "Currently live pool, or `Pubkey::default()`."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "instantCap",
            "docs": [
              "INSTANT funding (tier 0): the cap the trader paid for. 0 for trial-path traders.",
              "NOTE: appended field. Pre-upgrade profiles need re-creation (devnet: re-apply)."
            ],
            "type": "u64"
          },
          {
            "name": "feePaid",
            "docs": [
              "Entry/instant fee held in treasury-vault custody, waiting to be injected",
              "into the trader's pool as no-shares first-loss seed capital by",
              "`fund_next_in_queue` (Vault Ledger section 2/section 6). Never refunded. Zeroed when",
              "consumed. Appended: migrate_account zero-fills = no seed for",
              "pre-upgrade profiles."
            ],
            "type": "u64"
          },
          {
            "name": "feeForfeited",
            "docs": [
              "Fee from an attempt that ended without funding. A failed trial or a",
              "breach lock. Still sitting in treasury-vault custody, but no longer",
              "earmarked to seed anything, so `sweep_forfeited_fee` hands it to the",
              "CommonPool where it becomes investor value.",
              "",
              "Separate from `fee_paid` because a trader may re-apply before anyone",
              "sweeps: `apply_as_trader` overwrites `fee_paid` with the new attempt's",
              "fee, and without this bucket the old one would be silently dropped from",
              "the only record of it and stranded in the vault forever.",
              "",
              "Appended: migrate_account zero-fills. A profile that failed before this",
              "existed still has its fee in `fee_paid`, which the sweep also drains",
              "once the status is terminal."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "traderStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "applied"
          },
          {
            "name": "trial"
          },
          {
            "name": "failed"
          },
          {
            "name": "eligible"
          },
          {
            "name": "frozen"
          }
        ]
      }
    },
    {
      "name": "treasury",
      "docs": [
        "Entry-fee revenue, the ring-fenced keeper bounty reserve, and swept dust (section 4.10)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "revenue",
            "docs": [
              "Withdrawable by admin."
            ],
            "type": "u64"
          },
          {
            "name": "bountyReserve",
            "docs": [
              "Never withdrawable by admin; pays permissionless lock / unwind callers."
            ],
            "type": "u64"
          },
          {
            "name": "dustSwept",
            "type": "u64"
          },
          {
            "name": "bountiesPaid",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "trialCriteria",
      "docs": [
        "Trial pass criteria (section 5.4). Evaluated on-chain in `finalize_trial` against",
        "metrics attested by the trial engine's attestor key."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "startingBalance",
            "docs": [
              "Virtual starting balance, USDC base units ($50,000)."
            ],
            "type": "u64"
          },
          {
            "name": "profitTargetBps",
            "docs": [
              "Profit target, bps (800 = +8%)."
            ],
            "type": "u16"
          },
          {
            "name": "maxDrawdownBps",
            "docs": [
              "Max drawdown, bps (1_000)."
            ],
            "type": "u16"
          },
          {
            "name": "dailyLossBps",
            "docs": [
              "Daily loss cap, bps (400)."
            ],
            "type": "u16"
          },
          {
            "name": "minActiveDays",
            "docs": [
              "Minimum active days (15)."
            ],
            "type": "u16"
          },
          {
            "name": "minTrades",
            "docs": [
              "Minimum trades (20)."
            ],
            "type": "u32"
          },
          {
            "name": "maxDayProfitShareBps",
            "docs": [
              "No single day may exceed this share of total profit, bps (4_000 = 40%)."
            ],
            "type": "u16"
          },
          {
            "name": "daySecs",
            "docs": [
              "Length of one platform \"day\" in seconds. Trial days, live-trading days (tier",
              "promotion) and escrow vesting all use it. 86_400 in production; demos shorten it."
            ],
            "type": "u32"
          },
          {
            "name": "commitGraceDays",
            "docs": [
              "Extra days allowed to commit a day's root before the trial is invalidated (1 on devnet)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "trialFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "passed",
            "type": "bool"
          },
          {
            "name": "finalEquity",
            "type": "u64"
          },
          {
            "name": "maxDrawdownBps",
            "type": "u16"
          },
          {
            "name": "trades",
            "type": "u32"
          },
          {
            "name": "activeDays",
            "type": "u16"
          },
          {
            "name": "failReason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "trialMetrics",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "finalEquity",
            "type": "u64"
          },
          {
            "name": "maxDrawdownBps",
            "type": "u16"
          },
          {
            "name": "maxDailyLossBps",
            "type": "u16"
          },
          {
            "name": "activeDays",
            "type": "u16"
          },
          {
            "name": "trades",
            "type": "u32"
          },
          {
            "name": "maxDayProfitShareBps",
            "docs": [
              "Largest single day's profit as a share of total profit, bps."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "trialRootCommitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "day",
            "type": "u16"
          },
          {
            "name": "root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "updateParamsArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "risk",
            "type": {
              "option": {
                "defined": {
                  "name": "riskParams"
                }
              }
            }
          },
          {
            "name": "trial",
            "type": {
              "option": {
                "defined": {
                  "name": "trialCriteria"
                }
              }
            }
          },
          {
            "name": "tierCaps",
            "type": {
              "option": {
                "array": [
                  "u64",
                  3
                ]
              }
            }
          },
          {
            "name": "vestDays",
            "type": {
              "option": {
                "array": [
                  "u16",
                  3
                ]
              }
            }
          },
          {
            "name": "entryFee",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "activationFloor",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "minDeposit",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "keeperBounty",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "bountyPerPool",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "trialAttestor",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "priceAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "minFirstLossBps",
            "type": {
              "option": "u16"
            }
          }
        ]
      }
    },
    {
      "name": "venue",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "mockPerps"
          },
          {
            "name": "drift"
          }
        ]
      }
    }
  ]
};
