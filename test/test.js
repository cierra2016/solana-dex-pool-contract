const anchor = require("@project-serum/anchor")
const idl = require("./pool.json")

const token = require("@solana/spl-token")
const web3 = require("@solana/web3.js")

const programId = new web3.PublicKey("VmxBkH2i5Rx5LXeXvDyPMrKDzejwQzbor63jgKiVJoa")

async function sendTransaction(
  wallet,
  conn,
  transaction,
  signers
) {
  try{
    transaction.feePayer = wallet.publicKey
    transaction.recentBlockhash = (await conn.getRecentBlockhash('max')).blockhash;
    await transaction.setSigners(wallet.publicKey,...signers.map(s => s.publicKey));
    if(signers.length != 0)
      await transaction.partialSign(...signers)
    const signedTransaction = await wallet.signTransaction(transaction);
    let hash = await conn.sendRawTransaction(await signedTransaction.serialize());
    await conn.confirmTransaction(hash);
    console.log(hash)
  } catch(err) {
    console.log(err)
  }
}

const main = async() => {

  const wallet = new anchor.Wallet(web3.Keypair.generate());
  const connection = new web3.Connection(web3.clusterApiUrl('devnet'))
  const provider = new anchor.Provider(connection, wallet, anchor.Provider.defaultOptions());
  const program = new anchor.Program(idl, programId, provider);
  
  let sig1 = await connection.requestAirdrop(wallet.publicKey, 2 * web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig1);
  
  let pool
  let n_decimals = 9

  const initialize = async () => {
    let auth = web3.Keypair.generate();
    let sig = await connection.requestAirdrop(auth.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  
    let mint0 = await token.createMint(
      connection, 
      auth, 
      auth.publicKey, 
      auth.publicKey, 
      n_decimals, 
    );
    let mint1 = await token.createMint(
      connection, 
      auth, 
      auth.publicKey, 
      auth.publicKey, 
      n_decimals, 
    );
    let [poolState, poolState_b] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("pool_state"), mint0.toBuffer(), mint1.toBuffer()], 
      program.programId,
    );

    // all derive from state
    let [authority, authority_b] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("authority"), poolState.toBuffer()], 
      program.programId,
    );
    let [vault0, vault0_b] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("vault0"), poolState.toBuffer()], 
      program.programId,
    );
    let [vault1, vault1_b] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("vault1"), poolState.toBuffer()], 
      program.programId,
    );
    let [poolMint, poolMint_b] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("pool_mint"), poolState.toBuffer()], 
      program.programId,
    );

    //  1/10K = 0.01% fees 
    let fee_numerator = new anchor.BN(1);
    let fee_denominator = new anchor.BN(10000);

    let transaction = new web3.Transaction().add(
      program.instruction.initializePool(fee_numerator, fee_denominator, {
        accounts: {
          mint0: mint0, 
          mint1: mint1, 
          poolAuthority: authority,
          vault0: vault0,
          vault1: vault1,
          poolMint: poolMint,
          poolState: poolState,
          // the rest 
          payer: provider.wallet.publicKey, 
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: token.TOKEN_PROGRAM_ID, 
          associatedTokenProgram: token.ASSOCIATED_TOKEN_PROGRAM_ID, 
          rent: web3.SYSVAR_RENT_PUBKEY
        }
      })
    )
    await sendTransaction(wallet, connection, transaction, [])

    pool = {
      auth: auth,
      payer: auth,
      mint0: mint0,
      mint1: mint1,
      vault0: vault0,
      vault1: vault1,
      poolMint: poolMint,
      poolState: poolState,
      poolAuth: authority, 
    }
  
  };

      // helper function 
  async function setup_lp_provider(lp_user, amount) {
    // setup token accs for deposit 
    let mint0_ata = await token.createAssociatedTokenAccount(
      connection, pool.payer, pool.mint0, lp_user);
    let mint1_ata = await token.createAssociatedTokenAccount(
      connection, pool.payer, pool.mint1, lp_user);

    // setup token accs for LP pool tokens 
    let pool_mint_ata = await token.createAssociatedTokenAccount(
      connection, pool.payer, pool.poolMint, lp_user);

    // setup initial balance of mints 
    await token.mintTo(connection, 
      pool.payer, 
      pool.mint0, 
      mint0_ata, 
      pool.auth, 
      amount * 10 ** n_decimals
    );
    await token.mintTo(connection, 
      pool.payer, 
      pool.mint1, 
      mint1_ata, 
      pool.auth, 
      amount * 10 ** n_decimals
    );

    return [mint0_ata, mint1_ata, pool_mint_ata]
  }

  async function get_token_balance(pk) {
    return (await connection.getTokenAccountBalance(pk)).value.uiAmount;
  }

  function lp_amount(n) {
    return new anchor.BN(n * 10 ** n_decimals)
  }

  let lp_user0 // to be filled in 
  const addInitialLiquidity =  async () => {
    let lp_user_signer = web3.Keypair.generate();
    let lp_user = lp_user_signer.publicKey;
    let [user0, user1, poolAta] = await setup_lp_provider(lp_user, 100);

    lp_user0 = { // here 
      signer: lp_user_signer,
      user0: user0, 
      user1: user1, 
      poolAta: poolAta
    };

    let [src_amount0_in, src_amount1_in] = [
      lp_amount(50), 
      lp_amount(50)
    ];
    let transaction = new web3.Transaction().add(
      program.instruction.addLiquidity(src_amount0_in, src_amount1_in, {
        accounts: {
          // pool stuff 
          poolAuthority: pool.poolAuth,
          vault0: pool.vault0, 
          vault1: pool.vault1, 
          poolMint: pool.poolMint,
          poolState: pool.poolState, 
          // LP user stuff 
          user0: user0, 
          user1: user1, 
          userPoolAta: poolAta,
          owner: lp_user,
          // other stuff
          tokenProgram: token.TOKEN_PROGRAM_ID, 
        }
      })
    )
    await sendTransaction(wallet, connection, transaction, [lp_user_signer])

    // intializing pool liquidity -- mints 1 of each ... = 100% of pool amount 
    let balance_mint0 = await get_token_balance(poolAta)
    let poolState = await program.account.poolState.fetch(pool.poolState);
    let amountTotalMint = poolState.totalAmountMinted.toNumber();
    console.log("depsoiter0 pool mint: ", balance_mint0);
    console.log("total amount mint", amountTotalMint);

    // assert(balance_mint0 > 0);

    // ensure vault got some 
    let vb0 = await get_token_balance(pool.vault0);
    let vb1 = await get_token_balance(pool.vault1);
    console.log(vb0)
    console.log(vb1)
    
    // assert(vb0 > 0);
    // assert(vb1 > 0);
    // assert(vb1 == vb0); // 1:1
  }

  let lp_user1 // to be filled in 
  const add2InitialLiquidity = async () => {
    let lp_user_signer = web3.Keypair.generate();
    let lp_user = lp_user_signer.publicKey;
    let [user0, user1, poolAta] = await setup_lp_provider(lp_user, 100);

    lp_user1 = { // here 
      signer: lp_user_signer,
      user0: user0, 
      user1: user1, 
      poolAta: poolAta
    };

    let [src_amount0_in, src_amount1_in] = [
      lp_amount(50), 
      lp_amount(50)
    ];
    let transaction = new web3.Transaction().add(
      program.instruction.addLiquidity(src_amount0_in, src_amount1_in, {
        accounts: {
          // pool stuff 
          poolAuthority: pool.poolAuth,
          vault0: pool.vault0, 
          vault1: pool.vault1, 
          poolMint: pool.poolMint,
          poolState: pool.poolState, 
          // LP user stuff 
          user0: user0, 
          user1: user1, 
          userPoolAta: poolAta,
          owner: lp_user,
          // other stuff
          tokenProgram: token.TOKEN_PROGRAM_ID, 
        }
      })
    )
    await sendTransaction(wallet, connection, transaction, [lp_user_signer])

    // intializing pool liquidity -- mints 1 of each ... = 100% of pool amount 
    let balance_mint0 = await get_token_balance(poolAta)
    let poolState = await program.account.poolState.fetch(pool.poolState);
    let amountTotalMint = poolState.totalAmountMinted.toNumber();
    console.log("depsoiter1 pool mint: ", balance_mint0);
    console.log("total amount mint", amountTotalMint);

    // assert(balance_mint0 > 0);

    // ensure vault got some 
    let vb0 = await get_token_balance(pool.vault0);
    let vb1 = await get_token_balance(pool.vault1);
    console.log(vb0)
    console.log(vb1)
    
    // assert(vb0 > 0);
    // assert(vb1 > 0);
    // assert(vb1 == vb0); // 1:1
  }



  const add3InitialLiquidity = async () => {
    let lp_user_signer = web3.Keypair.generate();
    let lp_user = lp_user_signer.publicKey;
    let [user0, user1, poolAta] = await setup_lp_provider(lp_user, 100);

    let [src_amount0_in, src_amount1_in] = [
      lp_amount(25), 
      lp_amount(100)
    ];
    let transaction = new web3.Transaction().add(
      program.instruction.addLiquidity(src_amount0_in, src_amount1_in, {
        accounts: {
          // pool stuff 
          poolAuthority: pool.poolAuth,
          vault0: pool.vault0, 
          vault1: pool.vault1, 
          poolMint: pool.poolMint,
          poolState: pool.poolState, 
          // LP user stuff 
          user0: user0, 
          user1: user1, 
          userPoolAta: poolAta,
          owner: lp_user,
          // other stuff
          tokenProgram: token.TOKEN_PROGRAM_ID, 
        }
      })
    )

    await sendTransaction(wallet, connection, transaction, [lp_user_signer])
    // intializing pool liquidity -- mints 1 of each ... = 100% of pool amount 
    let balance_mint0 = await get_token_balance(poolAta)
    let poolState = await program.account.poolState.fetch(pool.poolState);
    let amountTotalMint = poolState.totalAmountMinted.toNumber();

    console.log("depsoiter pool mint: ", balance_mint0);
    console.log("total amount mint", amountTotalMint);

    // assert(balance_mint0 == 25 * 10 ** 9);
    // assert(balance_mint0 + 100 * 10 ** 9 == amountTotalMint);

    // ensure vault got some 
    let vb0 = await get_token_balance(pool.vault0);
    let vb1 = await get_token_balance(pool.vault1);
    console.log(vb0)
    console.log(vb1)
    
    // assert(vb0 > 0);
    // assert(vb1 > 0);
    // assert(vb1 == vb0); // still 1:1
  }

  const removeLiquidity =  async () => {

    let b_user0 = await get_token_balance(lp_user0.user0);
    let b_user1 = await get_token_balance(lp_user0.user1);
    let balance_mint0 = await get_token_balance(lp_user0.poolAta)

    let transaction = new web3.Transaction().add(
      program.instruction.removeLiquidity(lp_amount(50), {
        accounts: {
          // pool stuff 
          poolAuthority: pool.poolAuth,
          vault0: pool.vault0, 
          vault1: pool.vault1, 
          poolMint: pool.poolMint,
          poolState: pool.poolState, 
          // LP user stuff 
          user0: lp_user0.user0, 
          user1: lp_user0.user1, 
          userPoolAta: lp_user0.poolAta,
          owner: lp_user0.signer.publicKey,
          // other stuff
          tokenProgram: token.TOKEN_PROGRAM_ID, 
        }
      })
    )

    await sendTransaction(wallet, connection, transaction, [lp_user0.signer])

    let b_user0_2 = await get_token_balance(lp_user0.user0);
    let b_user1_2 = await get_token_balance(lp_user0.user1);
    let balance_mint0_2 = await get_token_balance(lp_user0.poolAta)

    // console.log(
    //   balance_mint0, balance_mint0_2,
    //   b_user0, b_user0_2,
    //   b_user1, b_user1_2
    // )

    // assert(balance_mint0 > balance_mint0_2);
    // assert(b_user0 < b_user0_2);
    // assert(b_user1 < b_user1_2);

    // ensure vault got some 
    let vb0 = await get_token_balance(pool.vault0);
    let vb1 = await get_token_balance(pool.vault1);
    console.log(vb0)
    console.log(vb1)
    
  };

  const swaps = async () => {
      let swapper_signer = web3.Keypair.generate();
      let swapper = swapper_signer.publicKey;

      // setup token accs for deposit 
      let mint0_ata = await token.createAssociatedTokenAccount(
        connection, pool.payer, pool.mint0, swapper);
      let mint1_ata = await token.createAssociatedTokenAccount(
        connection, pool.payer, pool.mint1, swapper);
  
      // setup initial balance of mints 
      let amount = 100; 
      await token.mintTo(connection, 
        pool.payer, 
        pool.mint0, 
        mint0_ata, 
        pool.auth, 
        amount * 10 ** n_decimals
      );

      let b0 = await get_token_balance(mint0_ata);
      let b1 = await get_token_balance(mint1_ata);
      
      // token0 -> token1
      let transaction = new web3.Transaction().add(
        program.instruction.swap(new anchor.BN(10 * 10 ** n_decimals), new anchor.BN(0),{
          accounts: {
              poolState: pool.poolState,
              poolAuthority: pool.poolAuth,
              vaultSrc: pool.vault0,
              vaultDst: pool.vault1,
              userSrc: mint0_ata,
              userDst: mint1_ata,
              owner: swapper,
              tokenProgram: token.TOKEN_PROGRAM_ID,
          }
        })
      )

      await sendTransaction(wallet, connection, transaction, [swapper_signer])

      let new_b0 = await get_token_balance(mint0_ata);
      let new_b1 = await get_token_balance(mint1_ata);

      // assert(new_b0 < b0);
      // assert(new_b1 > b1);
  };

  const removeLiquidityAfterSwap = async () => {

    let b_user0 = await get_token_balance(lp_user1.user0);
    let b_user1 = await get_token_balance(lp_user1.user1);
    let balance_mint0 = await get_token_balance(lp_user1.poolAta)

    let transaction = new web3.Transaction().add(
      program.instruction.removeLiquidity(lp_amount(50), {
        accounts: {
          // pool stuff 
          poolAuthority: pool.poolAuth,
          vault0: pool.vault0, 
          vault1: pool.vault1, 
          poolMint: pool.poolMint,
          poolState: pool.poolState, 
          // LP user stuff 
          user0: lp_user1.user0, 
          user1: lp_user1.user1, 
          userPoolAta: lp_user1.poolAta,
          owner: lp_user1.signer.publicKey,
          // other stuff
          tokenProgram: token.TOKEN_PROGRAM_ID, 
        }
      })
    )

    await sendTransaction(wallet, connection, transaction, [lp_user1.signer])
    let b_user0_2 = await get_token_balance(lp_user1.user0);
    let b_user1_2 = await get_token_balance(lp_user1.user1);
    let balance_mint0_2 = await get_token_balance(lp_user1.poolAta)

    console.log(
      balance_mint0, balance_mint0_2,
      b_user0, b_user0_2,
      b_user1, b_user1_2
    )

    // assert(balance_mint0 > balance_mint0_2);
    // assert(b_user0 < b_user0_2);
    // assert(b_user1 < b_user1_2);

    // earned profit from previous swap! :D
    // assert(b_user0_2 > b_user0 + 50); // more here 
    // assert(b_user1_2 < b_user1 + 50); // less here (impermantent loss)

    // ensure vault got some 
    let vb0 = await get_token_balance(pool.vault0);
    let vb1 = await get_token_balance(pool.vault1);
    console.log(vb0)
    console.log(vb1)
    
  };  

  console.log("initializes a new pool")
  await initialize()

  console.log("adds initial liquidity to the pool")
  await addInitialLiquidity()

  console.log('adds 2nd liquidity to the pool')
  await add2InitialLiquidity()

  console.log('adds 3rd liquidity to the pool')
  await add3InitialLiquidity()

  console.log("removes liquidity")
  await removeLiquidity()

  console.log("swap")
  await swaps()

  console.log("remove liquidity after swap")
  await removeLiquidityAfterSwap()

};

main()
